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

var (
	ErrCollectionNotFound = errors.New("collection not found")
	ErrItemNotFound       = errors.New("collection item not found")
	ErrVersionConflict    = errors.New("optimistic lock conflict: item has been modified by another user")
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
		VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, $8, $9)
	`
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	now := time.Now().UTC()
	c.Version = 1
	c.CreatedAt = now
	c.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, c.ID, c.WorkspaceID, c.ProjectID, c.Name, c.Description, c.MinRole, c.CreatedBy, c.CreatedAt, c.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert collection: %w", err)
	}
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
	return collections, nil
}

// UpdateCollection with OCC base_version check
func (r *CollectionRepository) UpdateCollection(ctx context.Context, c *domain.Collection, baseVersion int64) error {
	query := `
		UPDATE collections
		SET name = $1, description = $2, min_role = $3, version = version + 1, last_modified_by = $4, updated_at = $5
		WHERE id = $6 AND version = $7 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	if c.MinRole == "" {
		c.MinRole = domain.ProjectRoleReader
	}
	result, err := r.pool.Exec(ctx, query, c.Name, c.Description, c.MinRole, c.LastModifiedBy, now, c.ID, baseVersion)
	if err != nil {
		return fmt.Errorf("failed to update collection: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrVersionConflict
	}
	c.Version = baseVersion + 1
	c.UpdatedAt = now
	return nil
}

// MoveCollection moves a collection to a new workspace or project and touches child items updated_at atomically
func (r *CollectionRepository) MoveCollection(ctx context.Context, id uuid.UUID, workspaceID, projectID *uuid.UUID, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
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

	now := time.Now().UTC()
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

	now := time.Now().UTC()

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

	if item.ID == uuid.Nil {
		item.ID = uuid.New()
	}
	item.Version = 1
	item.CreatedAt = now
	item.UpdatedAt = now

	query := `
		INSERT INTO collection_items (
			id, collection_id, parent_id, type, name, sort_order,
			method, url, params, path_variables, headers, auth, body_type, raw_type,
			body_content, graphql_query, graphql_variables, body_form_data,
			pre_request_script, post_response_script, version, last_modified_by,
			created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18,
			$19, $20, 1, $21,
			$22, $23
		)
	`
	_, err = tx.Exec(ctx, query,
		item.ID, item.CollectionID, item.ParentID, string(item.Type), item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.PathVariables, item.Headers, item.Auth, item.BodyType, item.RawType,
		item.BodyContent, item.GraphQLQuery, item.GraphQLVariables, item.BodyFormData,
		item.PreRequestScript, item.PostResponseScript, item.LastModifiedBy,
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
		       pre_request_script, post_response_script, version, last_modified_by,
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
		&item.PreRequestScript, &item.PostResponseScript, &item.Version, &item.LastModifiedBy,
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

	now := time.Now().UTC()

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

	// 2. Update item with OCC check
	query := `
		UPDATE collection_items
		SET parent_id = $1, name = $2, sort_order = $3,
		    method = $4, url = $5, params = $6, path_variables = $7, headers = $8, auth = $9,
		    body_type = $10, raw_type = $11, body_content = $12, graphql_query = $13,
		    graphql_variables = $14, body_form_data = $15, pre_request_script = $16,
		    post_response_script = $17, version = version + 1, last_modified_by = $18,
		    updated_at = $19
		WHERE id = $20 AND version = $21 AND deleted_at IS NULL
	`
	result, err := tx.Exec(ctx, query,
		item.ParentID, item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.PathVariables, item.Headers, item.Auth,
		item.BodyType, item.RawType, item.BodyContent, item.GraphQLQuery,
		item.GraphQLVariables, item.BodyFormData, item.PreRequestScript,
		item.PostResponseScript, item.LastModifiedBy,
		now, item.ID, baseVersion,
	)
	if err != nil {
		return fmt.Errorf("failed to update item: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrVersionConflict
	}
	item.Version = baseVersion + 1
	item.UpdatedAt = now

	return tx.Commit(ctx)
}

// SoftDeleteItem marks an item as deleted (and recursively deletes all descendant items if folder),
// touching parent collection version atomically within a single transaction.
func (r *CollectionRepository) SoftDeleteItem(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	// Fetch collection_id and type of the item being deleted
	var colID uuid.UUID
	var itemType string
	err = tx.QueryRow(ctx, `SELECT collection_id, type FROM collection_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&colID, &itemType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrItemNotFound
		}
		return fmt.Errorf("failed to query item for deletion: %w", err)
	}

	now := time.Now().UTC()

	// 1. Touch parent collection version
	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	res, err := tx.Exec(ctx, colQuery, now, modifiedBy, colID)
	if err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	// 2. If folder: recursive CTE soft-delete all active descendants and the folder itself
	if itemType == string(domain.ItemTypeFolder) {
		recursiveQuery := `
			WITH RECURSIVE subtree AS (
				SELECT id FROM collection_items WHERE id = $1 AND deleted_at IS NULL
				UNION ALL
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
			return fmt.Errorf("failed to soft delete folder subtree: %w", err)
		}
		if result.RowsAffected() == 0 {
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
			return fmt.Errorf("failed to soft delete item: %w", err)
		}
		if result.RowsAffected() == 0 {
			return ErrItemNotFound
		}
	}

	return tx.Commit(ctx)
}

// ListActiveItemsByCollection returns non-deleted items for collection
func (r *CollectionRepository) ListActiveItemsByCollection(ctx context.Context, collectionID uuid.UUID) ([]*domain.CollectionItem, error) {
	query := `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, path_variables, headers, auth, body_type, raw_type,
		       body_content, graphql_query, graphql_variables, body_form_data,
		       pre_request_script, post_response_script, version, last_modified_by,
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
			&item.PreRequestScript, &item.PostResponseScript, &item.Version, &item.LastModifiedBy,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan item: %w", err)
		}
		item.Type = domain.ItemType(typeStr)
		items = append(items, &item)
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

func (r *CollectionRepository) execBatchReorder(ctx context.Context, collectionID uuid.UUID, items []domain.ReorderItemPosition, modifiedBy uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()

	// 1. Touch parent collection version and updated_at FIRST.
	// This acquires an exclusive row lock on collections(id) upfront, establishing a consistent
	// lock order (collections -> collection_items) that prevents deadlocks with concurrent syncs or reorders.
	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	if _, err := tx.Exec(ctx, colQuery, now, modifiedBy, collectionID); err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}

	// 2. Update items in deterministic sorted order
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

