package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	query := `
		INSERT INTO collections (id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 1, $6, $6, $7, $8)
	`
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	now := time.Now().UTC()
	c.Version = 1
	c.CreatedAt = now
	c.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, c.ID, c.WorkspaceID, c.ProjectID, c.Name, c.Description, c.CreatedBy, c.CreatedAt, c.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert collection: %w", err)
	}
	return nil
}

// GetCollectionByID gets a collection by ID (active or deleted)
func (r *CollectionRepository) GetCollectionByID(ctx context.Context, id uuid.UUID) (*domain.Collection, error) {
	query := `
		SELECT id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at, deleted_at
		FROM collections
		WHERE id = $1
	`
	var c domain.Collection
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description,
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
			SELECT id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE workspace_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *workspaceID)
	} else if projectID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at, deleted_at
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

	var collections []*domain.Collection
	for rows.Next() {
		var c domain.Collection
		if err := rows.Scan(
			&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description,
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
		SET name = $1, description = $2, version = version + 1, last_modified_by = $3, updated_at = $4
		WHERE id = $5 AND version = $6 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, c.Name, c.Description, c.LastModifiedBy, now, c.ID, baseVersion)
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

// SoftDeleteCollection sets tombstone
func (r *CollectionRepository) SoftDeleteCollection(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	query := `
		UPDATE collections
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, now, modifiedBy, id)
	if err != nil {
		return fmt.Errorf("failed to soft delete collection: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrCollectionNotFound
	}

	// Also tombstone all items in this collection
	itemsQuery := `
		UPDATE collection_items
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE collection_id = $3 AND deleted_at IS NULL
	`
	_, _ = r.pool.Exec(ctx, itemsQuery, now, modifiedBy, id)
	return nil
}

// CreateItem inserts a request or folder
func (r *CollectionRepository) CreateItem(ctx context.Context, item *domain.CollectionItem) error {
	query := `
		INSERT INTO collection_items (
			id, collection_id, parent_id, type, name, sort_order,
			method, url, params, headers, auth, body_type, raw_type,
			body_content, graphql_query, graphql_variables, body_form_data,
			pre_request_script, post_response_script, version, last_modified_by,
			created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17,
			$18, $19, 1, $20,
			$21, $22
		)
	`
	if item.ID == uuid.Nil {
		item.ID = uuid.New()
	}
	now := time.Now().UTC()
	item.Version = 1
	item.CreatedAt = now
	item.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query,
		item.ID, item.CollectionID, item.ParentID, string(item.Type), item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.Headers, item.Auth, item.BodyType, item.RawType,
		item.BodyContent, item.GraphQLQuery, item.GraphQLVariables, item.BodyFormData,
		item.PreRequestScript, item.PostResponseScript, item.LastModifiedBy,
		item.CreatedAt, item.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to create collection item: %w", err)
	}
	return nil
}

// GetItemByID returns item by ID
func (r *CollectionRepository) GetItemByID(ctx context.Context, id uuid.UUID) (*domain.CollectionItem, error) {
	query := `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, headers, auth, body_type, raw_type,
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
		&item.Method, &item.URL, &item.Params, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
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

// UpdateItem updates item with OCC base_version check
func (r *CollectionRepository) UpdateItem(ctx context.Context, item *domain.CollectionItem, baseVersion int64) error {
	query := `
		UPDATE collection_items
		SET parent_id = $1, name = $2, sort_order = $3,
		    method = $4, url = $5, params = $6, headers = $7, auth = $8,
		    body_type = $9, raw_type = $10, body_content = $11, graphql_query = $12,
		    graphql_variables = $13, body_form_data = $14, pre_request_script = $15,
		    post_response_script = $16, version = version + 1, last_modified_by = $17,
		    updated_at = $18
		WHERE id = $19 AND version = $20 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query,
		item.ParentID, item.Name, item.SortOrder,
		item.Method, item.URL, item.Params, item.Headers, item.Auth,
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
	return nil
}

// SoftDeleteItem marks an item as deleted (tombstone)
func (r *CollectionRepository) SoftDeleteItem(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	query := `
		UPDATE collection_items
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, now, modifiedBy, id)
	if err != nil {
		return fmt.Errorf("failed to soft delete item: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrItemNotFound
	}
	return nil
}

// ListActiveItemsByCollection returns non-deleted items for collection
func (r *CollectionRepository) ListActiveItemsByCollection(ctx context.Context, collectionID uuid.UUID) ([]*domain.CollectionItem, error) {
	query := `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, headers, auth, body_type, raw_type,
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

	var items []*domain.CollectionItem
	for rows.Next() {
		var item domain.CollectionItem
		var typeStr string
		err := rows.Scan(
			&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
			&item.Method, &item.URL, &item.Params, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
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

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
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

	// Touch parent collection version and updated_at for delta sync
	colQuery := `
		UPDATE collections
		SET updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	if _, err := tx.Exec(ctx, colQuery, now, modifiedBy, collectionID); err != nil {
		return fmt.Errorf("failed to touch collection version: %w", err)
	}

	return tx.Commit(ctx)
}

