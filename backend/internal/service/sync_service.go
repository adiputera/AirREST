package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SyncService struct {
	pool              *pgxpool.Pool
	collectionService *CollectionService
	envService        *EnvironmentService
}

func NewSyncService(
	pool *pgxpool.Pool,
	collectionService *CollectionService,
	envService *EnvironmentService,
) *SyncService {
	return &SyncService{
		pool:              pool,
		collectionService: collectionService,
		envService:        envService,
	}
}

type SyncDeltaResult struct {
	Collections  []*domain.Collection     `json:"collections"`
	Items        []*domain.CollectionItem `json:"items"`
	Environments []*domain.Environment    `json:"environments"`
	ServerTime   time.Time                `json:"server_time"`
}

// PullDelta fetches all changes (additions, updates, and tombstones) since a given timestamp
func (s *SyncService) PullDelta(
	ctx context.Context,
	user *domain.User,
	workspaceID, projectID *uuid.UUID,
	since time.Time,
) (*SyncDeltaResult, error) {
	if err := s.collectionService.CheckPermission(ctx, user, workspaceID, projectID, false); err != nil {
		return nil, err
	}

	result := &SyncDeltaResult{
		Collections:  []*domain.Collection{},
		Items:        []*domain.CollectionItem{},
		Environments: []*domain.Environment{},
		ServerTime:   time.Now().UTC(),
	}

	// 1. Fetch Collections
	var colQuery string
	var colParam uuid.UUID
	if workspaceID != nil {
		colQuery = `
			SELECT id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE workspace_id = $1 AND updated_at > $2
		`
		colParam = *workspaceID
	} else if projectID != nil {
		colQuery = `
			SELECT id, workspace_id, project_id, name, description, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE project_id = $1 AND updated_at > $2
		`
		colParam = *projectID
	} else {
		return nil, errors.New("must specify workspace_id or project_id")
	}

	colRows, err := s.pool.Query(ctx, colQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query collections delta: %w", err)
	}
	defer colRows.Close()

	for colRows.Next() {
		var c domain.Collection
		if err := colRows.Scan(
			&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description,
			&c.Version, &c.CreatedBy, &c.LastModifiedBy, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan collection delta: %w", err)
		}
		result.Collections = append(result.Collections, &c)
	}

	// 2. Fetch Items
	var itemQuery string
	if workspaceID != nil {
		itemQuery = `
			SELECT ci.id, ci.collection_id, ci.parent_id, ci.type, ci.name, ci.sort_order,
			       ci.method, ci.url, ci.params, ci.headers, ci.auth, ci.body_type, ci.raw_type,
			       ci.body_content, ci.graphql_query, ci.graphql_variables, ci.body_form_data,
			       ci.pre_request_script, ci.post_response_script, ci.version, ci.last_modified_by,
			       ci.created_at, ci.updated_at, ci.deleted_at
			FROM collection_items ci
			JOIN collections c ON ci.collection_id = c.id
			WHERE c.workspace_id = $1 AND ci.updated_at > $2
		`
	} else {
		itemQuery = `
			SELECT ci.id, ci.collection_id, ci.parent_id, ci.type, ci.name, ci.sort_order,
			       ci.method, ci.url, ci.params, ci.headers, ci.auth, ci.body_type, ci.raw_type,
			       ci.body_content, ci.graphql_query, ci.graphql_variables, ci.body_form_data,
			       ci.pre_request_script, ci.post_response_script, ci.version, ci.last_modified_by,
			       ci.created_at, ci.updated_at, ci.deleted_at
			FROM collection_items ci
			JOIN collections c ON ci.collection_id = c.id
			WHERE c.project_id = $1 AND ci.updated_at > $2
		`
	}

	itemRows, err := s.pool.Query(ctx, itemQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query item deltas: %w", err)
	}
	defer itemRows.Close()

	for itemRows.Next() {
		var item domain.CollectionItem
		var typeStr string
		if err := itemRows.Scan(
			&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
			&item.Method, &item.URL, &item.Params, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
			&item.BodyContent, &item.GraphQLQuery, &item.GraphQLVariables, &item.BodyFormData,
			&item.PreRequestScript, &item.PostResponseScript, &item.Version, &item.LastModifiedBy,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan item delta: %w", err)
		}
		item.Type = domain.ItemType(typeStr)
		result.Items = append(result.Items, &item)
	}

	// 3. Fetch Environments
	var envQuery string
	if workspaceID != nil {
		envQuery = `
			SELECT id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE workspace_id = $1 AND updated_at > $2
		`
	} else {
		envQuery = `
			SELECT id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE project_id = $1 AND updated_at > $2
		`
	}

	envRows, err := s.pool.Query(ctx, envQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query environments delta: %w", err)
	}
	defer envRows.Close()

	for envRows.Next() {
		var env domain.Environment
		if err := envRows.Scan(
			&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables,
			&env.Version, &env.LastModifiedBy, &env.CreatedAt, &env.UpdatedAt, &env.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan environment delta: %w", err)
		}
		result.Environments = append(result.Environments, &env)
	}

	return result, nil
}

// Batch Push Request and Response Types
type SyncCollectionMutation struct {
	Action      string            `json:"action"` // "create", "update", "delete"
	Collection  domain.Collection `json:"collection"`
	BaseVersion int64             `json:"base_version"`
}

type SyncItemMutation struct {
	Action      string                `json:"action"` // "create", "update", "delete"
	Item        domain.CollectionItem `json:"item"`
	BaseVersion int64                 `json:"base_version"`
}

type SyncEnvironmentMutation struct {
	Action      string             `json:"action"` // "create", "update", "delete"
	Environment domain.Environment `json:"environment"`
	BaseVersion int64              `json:"base_version"`
}

type SyncPushRequest struct {
	WorkspaceID  *uuid.UUID                `json:"workspace_id,omitempty"`
	ProjectID    *uuid.UUID                `json:"project_id,omitempty"`
	Collections  []SyncCollectionMutation  `json:"collections,omitempty"`
	Items        []SyncItemMutation        `json:"items,omitempty"`
	Environments []SyncEnvironmentMutation `json:"environments,omitempty"`
}

type SyncConflictReport struct {
	ID         uuid.UUID `json:"id"`
	Type       string    `json:"type"` // "collection", "item", "environment"
	Message    string    `json:"message"`
	ServerData any       `json:"server_data,omitempty"`
}

type SyncPushResponse struct {
	AppliedIDs []uuid.UUID          `json:"applied_ids"`
	Conflicts  []SyncConflictReport `json:"conflicts"`
	ServerTime time.Time            `json:"server_time"`
}

// PushChangeset processes a batch of offline mutations, applying non-conflicting mutations
// and returning detailed conflict reports for any stale updates.
func (s *SyncService) PushChangeset(ctx context.Context, user *domain.User, req SyncPushRequest) (*SyncPushResponse, error) {
	if err := s.collectionService.CheckPermission(ctx, user, req.WorkspaceID, req.ProjectID, true); err != nil {
		return nil, err
	}

	resp := &SyncPushResponse{
		AppliedIDs: []uuid.UUID{},
		Conflicts:  []SyncConflictReport{},
		ServerTime: time.Now().UTC(),
	}

	// 1. Process Collection Mutations
	for _, m := range req.Collections {
		switch m.Action {
		case "create":
			col := m.Collection
			if req.WorkspaceID != nil {
				col.WorkspaceID = req.WorkspaceID
			}
			if req.ProjectID != nil {
				col.ProjectID = req.ProjectID
			}
			if err := s.collectionService.CreateCollection(ctx, user, &col); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, col.ID)
			}
		case "update":
			col := m.Collection
			if err := s.collectionService.UpdateCollection(ctx, user, &col, m.BaseVersion); err != nil {
				latest, _ := s.collectionService.GetCollection(ctx, user, col.ID)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:         col.ID,
					Type:       "collection",
					Message:    err.Error(),
					ServerData: latest,
				})
			} else {
				resp.AppliedIDs = append(resp.AppliedIDs, col.ID)
			}
		case "delete":
			if err := s.collectionService.DeleteCollection(ctx, user, m.Collection.ID); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, m.Collection.ID)
			}
		}
	}

	// 2. Process Item Mutations
	for _, m := range req.Items {
		switch m.Action {
		case "create":
			item := m.Item
			if err := s.collectionService.CreateItem(ctx, user, &item); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, item.ID)
			}
		case "update":
			item := m.Item
			updated, err := s.collectionService.UpdateItem(ctx, user, &item, m.BaseVersion)
			if err != nil {
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:         item.ID,
					Type:       "item",
					Message:    err.Error(),
					ServerData: updated,
				})
			} else {
				resp.AppliedIDs = append(resp.AppliedIDs, item.ID)
			}
		case "delete":
			if err := s.collectionService.DeleteItem(ctx, user, m.Item.ID); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, m.Item.ID)
			}
		}
	}

	// 3. Process Environment Mutations
	for _, m := range req.Environments {
		switch m.Action {
		case "create":
			env := m.Environment
			if req.WorkspaceID != nil {
				env.WorkspaceID = req.WorkspaceID
			}
			if req.ProjectID != nil {
				env.ProjectID = req.ProjectID
			}
			if err := s.envService.Create(ctx, user, &env); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, env.ID)
			}
		case "update":
			env := m.Environment
			updated, err := s.envService.Update(ctx, user, &env, m.BaseVersion)
			if err != nil {
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:         env.ID,
					Type:       "environment",
					Message:    err.Error(),
					ServerData: updated,
				})
			} else {
				resp.AppliedIDs = append(resp.AppliedIDs, env.ID)
			}
		case "delete":
			if err := s.envService.Delete(ctx, user, m.Environment.ID); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, m.Environment.ID)
			}
		}
	}

	return resp, nil
}

type ImportCollectionRequest struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	Description *string                 `json:"description,omitempty"`
	Items       []ImportItemRequest     `json:"items,omitempty"`
}

type ImportItemRequest struct {
	ID                 string                  `json:"id"`
	ParentID           *string                 `json:"parent_id,omitempty"`
	Type               string                  `json:"type"`
	Name               string                  `json:"name"`
	SortOrder          int                     `json:"sort_order"`
	Method             *string                 `json:"method,omitempty"`
	URL                *string                 `json:"url,omitempty"`
	Params             *json.RawMessage        `json:"params,omitempty"`
	Headers            *json.RawMessage        `json:"headers,omitempty"`
	Auth               *json.RawMessage        `json:"auth,omitempty"`
	BodyType           *string                 `json:"body_type,omitempty"`
	RawType            *string                 `json:"raw_type,omitempty"`
	BodyContent        *string                 `json:"body_content,omitempty"`
	GraphQLQuery       *string                 `json:"graphql_query,omitempty"`
	GraphQLVariables   *string                 `json:"graphql_variables,omitempty"`
	BodyFormData       *json.RawMessage        `json:"body_form_data,omitempty"`
	PreRequestScript   *string                 `json:"pre_request_script,omitempty"`
	PostResponseScript *string                 `json:"post_response_script,omitempty"`
	Items              []ImportItemRequest     `json:"items,omitempty"`
}

// ImportBatch allows claiming and migrating offline LocalStorage collections into user's workspace
func (s *SyncService) ImportBatch(ctx context.Context, user *domain.User, workspaceID uuid.UUID, collections []ImportCollectionRequest) error {
	if err := s.collectionService.CheckPermission(ctx, user, &workspaceID, nil, true); err != nil {
		return err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to start import transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()

	for _, colReq := range collections {
		colID, err := uuid.Parse(colReq.ID)
		if err != nil {
			colID = uuid.New()
		}

		insertColQuery := `
			INSERT INTO collections (id, workspace_id, name, description, version, created_by, last_modified_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $6)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = EXCLUDED.updated_at
		`
		if _, err := tx.Exec(ctx, insertColQuery, colID, workspaceID, colReq.Name, colReq.Description, user.ID, now); err != nil {
			return fmt.Errorf("failed to insert imported collection: %w", err)
		}

		if err := s.insertImportItems(ctx, tx, colID, nil, colReq.Items, user.ID, now); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (s *SyncService) insertImportItems(
	ctx context.Context,
	tx pgx.Tx,
	colID uuid.UUID,
	parentID *uuid.UUID,
	items []ImportItemRequest,
	userID uuid.UUID,
	now time.Time,
) error {
	for _, itemReq := range items {
		itemID, err := uuid.Parse(itemReq.ID)
		if err != nil {
			itemID = uuid.New()
		}

		itemType := itemReq.Type
		if itemType == "" {
			itemType = "request"
		}

		insertItemQuery := `
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
				$21, $21
			)
			ON CONFLICT (id) DO UPDATE SET
				name = EXCLUDED.name,
				method = EXCLUDED.method,
				url = EXCLUDED.url,
				params = EXCLUDED.params,
				headers = EXCLUDED.headers,
				body_content = EXCLUDED.body_content,
				updated_at = EXCLUDED.updated_at
		`

		_, err = tx.Exec(ctx, insertItemQuery,
			itemID, colID, parentID, itemType, itemReq.Name, itemReq.SortOrder,
			itemReq.Method, itemReq.URL, itemReq.Params, itemReq.Headers, itemReq.Auth,
			itemReq.BodyType, itemReq.RawType, itemReq.BodyContent, itemReq.GraphQLQuery,
			itemReq.GraphQLVariables, itemReq.BodyFormData, itemReq.PreRequestScript,
			itemReq.PostResponseScript, userID, now,
		)
		if err != nil {
			return fmt.Errorf("failed to import item %s: %w", itemReq.Name, err)
		}

		if len(itemReq.Items) > 0 {
			if err := s.insertImportItems(ctx, tx, colID, &itemID, itemReq.Items, userID, now); err != nil {
				return err
			}
		}
	}
	return nil
}
