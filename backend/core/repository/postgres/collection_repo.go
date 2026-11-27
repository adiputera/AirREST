package postgres

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const MaxItemsPerCollection = 5000

var (
	ErrCollectionNotFound  = errors.New("collection not found")
	ErrItemNotFound        = errors.New("collection item not found")
	ErrVersionConflict     = errors.New("optimistic lock conflict: item has been modified by another user")
	ErrInvalidReorder      = errors.New("invalid reorder hierarchy: cycle detected, missing parent folder, or max depth exceeded")
	ErrCollectionItemLimit = errors.New("collection item limit exceeded")
)

type CollectionRepository struct {
	pool *pgxpool.Pool
}

func NewCollectionRepository(pool *pgxpool.Pool) *CollectionRepository {
	return &CollectionRepository{pool: pool}
}

// CreateCollection inserts a collection with version 1
func (r *CollectionRepository) CreateCollection(ctx context.Context, c *domain.Collection) error {
	if c.MinRole == "" {
		c.MinRole = domain.ProjectRoleReader
	}
	query := `
		INSERT INTO collections (id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, clock_timestamp(), clock_timestamp())
		RETURNING created_at, updated_at
	`
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	c.Version = 1

	err := r.pool.QueryRow(ctx, query, c.ID, c.WorkspaceID, c.ProjectID, c.Name, c.Description, c.MinRole, c.CreatedBy).Scan(&c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert collection: %w", err)
	}
	c.CreatedAt = c.CreatedAt.UTC()
	c.UpdatedAt = c.UpdatedAt.UTC()
	return nil
}

// GetCollectionByID gets a collection by ID (active or deleted)
func (r *CollectionRepository) GetCollectionByID(ctx context.Context, id uuid.UUID) (*domain.Collection, error) {
	query := `
		SELECT id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at, deleted_at
		FROM collections
		WHERE id = $1
	`
	var c domain.Collection
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description, &c.MinRole,
		&c.Version, &c.CreatedBy, &c.LastModifiedBy, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCollectionNotFound
		}
		return nil, fmt.Errorf("failed to get collection: %w", err)
	}
	return &c, nil
}

// ListCollections lists active collections in a workspace or project
func (r *CollectionRepository) ListCollections(ctx context.Context, workspaceID, projectID *uuid.UUID) ([]*domain.Collection, error) {
	var query string
	var rows pgx.Rows
	var err error

	if workspaceID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE workspace_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *workspaceID)
	} else if projectID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE project_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *projectID)
	} else {
		return nil, errors.New("must specify workspace_id or project_id")
	}

	if err != nil {
		return nil, fmt.Errorf("failed to query collections: %w", err)
	}
	defer rows.Close()

	collections := make([]*domain.Collection, 0)
	for rows.Next() {
		var c domain.Collection
		if err := rows.Scan(
			&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description, &c.MinRole,
			&c.Version, &c.CreatedBy, &c.LastModifiedBy, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan collection: %w", err)
		}
		collections = append(collections, &c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate collections: %w", err)
	}
	return collections, nil
}

// UpdateCollection with OCC base_version check
func (r *CollectionRepository) UpdateCollection(ctx context.Context, c *domain.Collection, baseVersion int64) error {
	query := `
		UPDATE collections
		SET name = $1, description = $2, min_role = $3, version = version + 1, last_modified_by = $4, updated_at = clock_timestamp()
		WHERE id = $5 AND version = $6 AND deleted_at IS NULL
		RETURNING updated_at
	`
	if c.MinRole == "" {
		c.MinRole = domain.ProjectRoleReader
	}
	err := r.pool.QueryRow(ctx, query, c.Name, c.Description, c.MinRole, c.LastModifiedBy, c.ID, baseVersion).Scan(&c.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrVersionConflict
		}
		return fmt.Errorf("failed to update collection: %w", err)
	}
	c.Version = baseVersion + 1
	c.UpdatedAt = c.UpdatedAt.UTC()
	return nil
}

// MoveCollection moves a collection to a new workspace or project and touches child items updated_at atomically.
// When expected is provided, the collection row is locked FOR UPDATE and verified against the authorized snapshot.
func (r *CollectionRepository) MoveCollection(ctx context.Context, id uuid.UUID, expected *domain.Collection, workspaceID, projectID *uuid.UUID, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var current domain.Collection
	err = tx.QueryRow(ctx, `
		SELECT id, workspace_id, project_id, min_role
		FROM collections
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE
	`, id).Scan(&current.ID, &current.WorkspaceID, &current.ProjectID, &current.MinRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrCollectionNotFound
	}
	if err != nil {
		return fmt.Errorf("failed to lock collection for move: %w", err)
	}
	if expected != nil {
		if !sameOptionalUUID(current.WorkspaceID, expected.WorkspaceID) ||
			!sameOptionalUUID(current.ProjectID, expected.ProjectID) ||
			current.MinRole != expected.MinRole {
			return ErrVersionConflict
		}
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()
	query := `
		UPDATE collections
		SET workspace_id = $1, project_id = $2, version = version + 1, last_modified_by = $3, updated_at = $4
		WHERE id = $5 AND deleted_at IS NULL
	`
	result, err := tx.Exec(ctx, query, workspaceID, projectID, modifiedBy, now, id)
	if err != nil {
		return fmt.Errorf("failed to move collection: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	itemsQuery := `
		UPDATE collection_items
		SET updated_at = $1, last_modified_by = $2
		WHERE collection_id = $3 AND deleted_at IS NULL
	`
	if _, err := tx.Exec(ctx, itemsQuery, now, modifiedBy, id); err != nil {
		return fmt.Errorf("failed to update collection items on move: %w", err)
	}

	return tx.Commit(ctx)
}

// SoftDeleteCollection sets tombstone atomically for collection and all child items
func (r *CollectionRepository) SoftDeleteCollection(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()
	query := `
		UPDATE collections
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	result, err := tx.Exec(ctx, query, now, modifiedBy, id)
	if err != nil {
		return fmt.Errorf("failed to soft delete collection: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	// Also tombstone all items in this collection within the same transaction and propagate error
	itemsQuery := `
		UPDATE collection_items
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE collection_id = $3 AND deleted_at IS NULL
	`
	if _, err := tx.Exec(ctx, itemsQuery, now, modifiedBy, id); err != nil {
		return fmt.Errorf("failed to soft delete collection items: %w", err)
	}

	return tx.Commit(ctx)
}

// CreateItem inserts a request or folder and touches parent collection version atomically
func (r *CollectionRepository) CreateItem(ctx context.Context, item *domain.CollectionItem) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()

	// 1. Lock and touch parent collection
	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	res, err := tx.Exec(ctx, colQuery, now, item.LastModifiedBy, item.CollectionID)
	if err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	var activeCount int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM collection_items WHERE collection_id = $1 AND deleted_at IS NULL`, item.CollectionID).Scan(&activeCount); err != nil {
		return fmt.Errorf("failed to count collection items: %w", err)
	}
	if activeCount >= MaxItemsPerCollection {
		return ErrCollectionItemLimit
	}

	if item.ID == uuid.Nil {
		item.ID = uuid.New()
	}
	item.Version = 1
	item.CreatedAt = now
	item.UpdatedAt = now

	examplesArg := "[]"
	if item.Type == domain.ItemTypeRequest && item.Examples.Present && !item.Examples.IsNull && len(item.Examples.Raw) > 0 {
		examplesArg = string(item.Examples.Raw)
	}
	item.Examples = domain.NewOptionalRawJSON([]byte(examplesArg))

	query := `
		INSERT INTO collection_items (
			id, collection_id, parent_id, type, name, sort_order,
			method, url, params, path_variables, headers, auth, body_type, raw_type,
			body_content, graphql_query, graphql_variables, body_form_data,
			pre_request_script, post_response_script, examples, version, last_modified_by,
			created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18,
			$19, $20, $21::jsonb, 1, $22,
			$23, $24
		)
	`
	_, err = tx.Exec(ctx, query,
		item.ID, item.CollectionID, item.ParentID, string(item.Type), item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.PathVariables, item.Headers, item.Auth, item.BodyType, item.RawType,
		item.BodyContent, item.GraphQLQuery, item.GraphQLVariables, item.BodyFormData,
		item.PreRequestScript, item.PostResponseScript, examplesArg, item.LastModifiedBy,
		item.CreatedAt, item.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create collection item: %w", err)
	}

	return tx.Commit(ctx)
}

// GetItemByID returns item by ID
func (r *CollectionRepository) GetItemByID(ctx context.Context, id uuid.UUID) (*domain.CollectionItem, error) {
	query := `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, path_variables, headers, auth, body_type, raw_type,
		       body_content, graphql_query, graphql_variables, body_form_data,
		       pre_request_script, post_response_script, examples, version, last_modified_by,
		       created_at, updated_at, deleted_at
		FROM collection_items
		WHERE id = $1
	`
	var item domain.CollectionItem
	var typeStr string
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
		&item.Method, &item.URL, &item.Params, &item.PathVariables, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
		&item.BodyContent, &item.GraphQLQuery, &item.GraphQLVariables, &item.BodyFormData,
		&item.PreRequestScript, &item.PostResponseScript, &item.Examples, &item.Version, &item.LastModifiedBy,
		&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrItemNotFound
		}
		return nil, fmt.Errorf("failed to get collection item: %w", err)
	}
	item.Type = domain.ItemType(typeStr)
	return &item, nil
}

// UpdateItem updates item with OCC base_version check and touches parent collection version atomically
func (r *CollectionRepository) UpdateItem(ctx context.Context, item *domain.CollectionItem, baseVersion int64) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()

	// 1. Lock and touch parent collection
	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	res, err := tx.Exec(ctx, colQuery, now, item.LastModifiedBy, item.CollectionID)
	if err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	updateExamples := item.Examples.Present && !item.Examples.IsNull
	examplesArg := "[]"
	if updateExamples {
		if item.Type == domain.ItemTypeFolder {
			examplesArg = "[]"
		} else if len(item.Examples.Raw) > 0 {
			examplesArg = string(item.Examples.Raw)
		}
	}

	// 2. Update item with OCC check, preserving examples when omitted
	query := `
		UPDATE collection_items
		SET parent_id = $1, name = $2, sort_order = $3,
		    method = $4, url = $5, params = $6, path_variables = $7, headers = $8, auth = $9,
		    body_type = $10, raw_type = $11, body_content = $12, graphql_query = $13,
		    graphql_variables = $14, body_form_data = $15, pre_request_script = $16,
		    post_response_script = $17,
		    examples = CASE WHEN $18 THEN $19::jsonb ELSE examples END,
		    version = version + 1, last_modified_by = $20,
		    updated_at = $21
		WHERE id = $22 AND version = $23 AND deleted_at IS NULL
		RETURNING examples
	`
	var savedExamples domain.OptionalRawJSON
	err = tx.QueryRow(ctx, query,
		item.ParentID, item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.PathVariables, item.Headers, item.Auth,
		item.BodyType, item.RawType, item.BodyContent, item.GraphQLQuery,
		item.GraphQLVariables, item.BodyFormData, item.PreRequestScript,
		item.PostResponseScript, updateExamples, examplesArg, item.LastModifiedBy,
		now, item.ID, baseVersion,
	).Scan(&savedExamples)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrVersionConflict
		}
		return fmt.Errorf("failed to update item: %w", err)
	}
	item.Examples = savedExamples
	item.Version = baseVersion + 1
	item.UpdatedAt = now

	return tx.Commit(ctx)
}

// SoftDeleteItem marks an item as deleted (and recursively deletes all descendant items if folder),
// locking collections before collection_items to match MoveItem/UpdateItem/BatchReorderItems lock order.
func (r *CollectionRepository) SoftDeleteItem(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	for attempt := 0; attempt < 3; attempt++ {
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin transaction: %w", err)
		}

		// Peek collection_id before acquiring row locks so collections is always locked first
		var colID uuid.UUID
		err = tx.QueryRow(ctx, `SELECT collection_id FROM collection_items WHERE id = $1 AND deleted_at IS NULL`, id).Scan(&colID)
		if err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrItemNotFound
			}
			return fmt.Errorf("failed to query item for deletion: %w", err)
		}

		var now time.Time
		if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("failed to read database timestamp: %w", err)
		}
		now = now.UTC()

		// 1. Lock and touch parent collection version first
		colQuery := `
			UPDATE collections
			SET updated_at = $1, last_modified_by = $2, version = version + 1
			WHERE id = $3 AND deleted_at IS NULL
		`
		res, err := tx.Exec(ctx, colQuery, now, modifiedBy, colID)
		if err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("failed to touch collection version: %w", err)
		}
		if res.RowsAffected() == 0 {
			tx.Rollback(ctx)
			return ErrCollectionNotFound
		}

		// 2. Lock the item row FOR UPDATE and verify it did not move collections concurrently
		var lockedColID uuid.UUID
		var itemType string
		err = tx.QueryRow(ctx, `SELECT collection_id, type FROM collection_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&lockedColID, &itemType)
		if err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrItemNotFound
			}
			return fmt.Errorf("failed to lock item for deletion: %w", err)
		}
		if lockedColID != colID {
			tx.Rollback(ctx)
			continue
		}

		// 3. If folder: recursive CTE soft-delete all active descendants and the folder itself
		if itemType == string(domain.ItemTypeFolder) {
			recursiveQuery := `
				WITH RECURSIVE subtree AS (
					SELECT id FROM collection_items WHERE id = $1 AND deleted_at IS NULL
					UNION
					SELECT ci.id FROM collection_items ci
					INNER JOIN subtree s ON ci.parent_id = s.id
					WHERE ci.deleted_at IS NULL AND ci.collection_id = $2
				)
				UPDATE collection_items
				SET deleted_at = $3, updated_at = $3, last_modified_by = $4, version = version + 1
				WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL
			`
			result, err := tx.Exec(ctx, recursiveQuery, id, colID, now, modifiedBy)
			if err != nil {
				tx.Rollback(ctx)
				return fmt.Errorf("failed to soft delete folder subtree: %w", err)
			}
			if result.RowsAffected() == 0 {
				tx.Rollback(ctx)
				return ErrItemNotFound
			}
		} else {
			// Single request item
			query := `
				UPDATE collection_items
				SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
				WHERE id = $3 AND deleted_at IS NULL
			`
			result, err := tx.Exec(ctx, query, now, modifiedBy, id)
			if err != nil {
				tx.Rollback(ctx)
				return fmt.Errorf("failed to soft delete item: %w", err)
			}
			if result.RowsAffected() == 0 {
				tx.Rollback(ctx)
				return ErrItemNotFound
			}
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("failed to commit item deletion: %w", err)
		}
		return nil
	}

	return ErrVersionConflict
}

// ListActiveItemsByCollection returns non-deleted items for collection
func (r *CollectionRepository) ListActiveItemsByCollection(ctx context.Context, collectionID uuid.UUID) ([]*domain.CollectionItem, error) {
	query := `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, path_variables, headers, auth, body_type, raw_type,
		       body_content, graphql_query, graphql_variables, body_form_data,
		       pre_request_script, post_response_script, examples, version, last_modified_by,
		       created_at, updated_at, deleted_at
		FROM collection_items
		WHERE collection_id = $1 AND deleted_at IS NULL
		ORDER BY sort_order ASC, created_at ASC
	`
	rows, err := r.pool.Query(ctx, query, collectionID)
	if err != nil {
		return nil, fmt.Errorf("failed to list items: %w", err)
	}
	defer rows.Close()

	items := make([]*domain.CollectionItem, 0)
	for rows.Next() {
		var item domain.CollectionItem
		var typeStr string
		err := rows.Scan(
			&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
			&item.Method, &item.URL, &item.Params, &item.PathVariables, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
			&item.BodyContent, &item.GraphQLQuery, &item.GraphQLVariables, &item.BodyFormData,
			&item.PreRequestScript, &item.PostResponseScript, &item.Examples, &item.Version, &item.LastModifiedBy,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan item: %w", err)
		}
		item.Type = domain.ItemType(typeStr)
		items = append(items, &item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate collection items: %w", err)
	}
	return items, nil
}

// BatchReorderItems updates sort_order and parent_id for multiple items in a collection inside a single transaction
func (r *CollectionRepository) BatchReorderItems(ctx context.Context, collectionID uuid.UUID, items []domain.ReorderItemPosition, modifiedBy uuid.UUID) error {
	if len(items) == 0 {
		return nil
	}

	// Sort items deterministically by ID to ensure uniform row-lock acquisition order
	sortedItems := make([]domain.ReorderItemPosition, len(items))
	copy(sortedItems, items)
	sort.Slice(sortedItems, func(i, j int) bool {
		return sortedItems[i].ID.String() < sortedItems[j].ID.String()
	})

	const maxRetries = 3
	for attempt := 0; attempt < maxRetries; attempt++ {
		err := r.execBatchReorder(ctx, collectionID, sortedItems, modifiedBy)
		if err == nil {
			return nil
		}

		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001") {
			if attempt < maxRetries-1 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(time.Duration(50*(attempt+1)) * time.Millisecond):
					continue
				}
			}
		}
		return err
	}

	return nil
}

type reorderTreeNode struct {
	ID       uuid.UUID
	ParentID *uuid.UUID
	Type     domain.ItemType
}

// ValidateBatchReorderHierarchy verifies that applying the proposed parent_id updates
// leaves every item pointing to a valid folder without cycles and within maxItemMoveDepth.
func ValidateBatchReorderHierarchy(nodes map[uuid.UUID]reorderTreeNode, items []domain.ReorderItemPosition) error {
	proposedParents := make(map[uuid.UUID]*uuid.UUID, len(nodes))
	for id, node := range nodes {
		proposedParents[id] = node.ParentID
	}

	for _, pos := range items {
		if _, exists := nodes[pos.ID]; !exists {
			return ErrItemNotFound
		}
		if pos.ParentID != nil {
			if *pos.ParentID == pos.ID {
				return ErrInvalidReorder
			}
			parentNode, exists := nodes[*pos.ParentID]
			if !exists || parentNode.Type != domain.ItemTypeFolder {
				return ErrInvalidReorder
			}
		}
		proposedParents[pos.ID] = pos.ParentID
	}

	const (
		unvisited = 0
		visiting  = 1
		visited   = 2
	)
	state := make(map[uuid.UUID]int, len(nodes))
	depthCache := make(map[uuid.UUID]int, len(nodes))

	var computeDepth func(id uuid.UUID) (int, error)
	computeDepth = func(id uuid.UUID) (int, error) {
		if st := state[id]; st == visiting {
			return 0, ErrInvalidReorder
		} else if st == visited {
			return depthCache[id], nil
		}

		state[id] = visiting
		parentID := proposedParents[id]
		depth := 1
		if parentID != nil {
			parentNode, exists := nodes[*parentID]
			if !exists || parentNode.Type != domain.ItemTypeFolder {
				return 0, ErrInvalidReorder
			}
			parentDepth, err := computeDepth(*parentID)
			if err != nil {
				return 0, err
			}
			depth = parentDepth + 1
		}
		if depth > maxItemMoveDepth {
			return 0, ErrInvalidReorder
		}
		state[id] = visited
		depthCache[id] = depth
		return depth, nil
	}

	for id := range nodes {
		if _, err := computeDepth(id); err != nil {
			return err
		}
	}
	return nil
}

func (r *CollectionRepository) execBatchReorder(ctx context.Context, collectionID uuid.UUID, items []domain.ReorderItemPosition, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Lock parent collection FIRST (collections -> collection_items lock order)
	// and verify it exists and is active.
	var colVersion int64
	err = tx.QueryRow(ctx, `
		SELECT version
		FROM collections
		WHERE id = $1 AND deleted_at IS NULL
		FOR UPDATE
	`, collectionID).Scan(&colVersion)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrCollectionNotFound
		}
		return fmt.Errorf("failed to lock collection for reorder: %w", err)
	}

	// 2. Lock active items in deterministic UUID order and validate full hierarchy against cycles & max depth.
	treeRows, err := tx.Query(ctx, `
		SELECT id, parent_id, type
		FROM collection_items
		WHERE collection_id = $1 AND deleted_at IS NULL
		ORDER BY id ASC
		FOR UPDATE
	`, collectionID)
	if err != nil {
		return fmt.Errorf("failed to lock collection items for reorder: %w", err)
	}
	nodes := make(map[uuid.UUID]reorderTreeNode)
	for treeRows.Next() {
		var id uuid.UUID
		var parentID *uuid.UUID
		var typeStr string
		if err := treeRows.Scan(&id, &parentID, &typeStr); err != nil {
			treeRows.Close()
			return fmt.Errorf("failed to scan collection item for reorder: %w", err)
		}
		nodes[id] = reorderTreeNode{ID: id, ParentID: parentID, Type: domain.ItemType(typeStr)}
	}
	if err := treeRows.Err(); err != nil {
		treeRows.Close()
		return fmt.Errorf("failed to iterate collection items for reorder: %w", err)
	}
	treeRows.Close()

	if err := ValidateBatchReorderHierarchy(nodes, items); err != nil {
		return err
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()

	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	res, err := tx.Exec(ctx, colQuery, now, modifiedBy, collectionID)
	if err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	// 3. Update items in deterministic sorted order
	query := `
		UPDATE collection_items
		SET parent_id = $1, sort_order = $2, updated_at = $3, last_modified_by = $4, version = version + 1
		WHERE id = $5 AND collection_id = $6 AND deleted_at IS NULL
	`
	for _, item := range items {
		_, err := tx.Exec(ctx, query, item.ParentID, item.SortOrder, now, modifiedBy, item.ID, collectionID)
		if err != nil {
			return fmt.Errorf("failed to update item %s position: %w", item.ID, err)
		}
	}

	return tx.Commit(ctx)
}

