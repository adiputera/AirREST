package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	}

	var userRole domain.ProjectRole
	if projectID != nil && !user.IsSuperadmin() {
		var err error
		userRole, err = s.collectionService.projectService.GetEffectiveRole(ctx, user, *projectID)
		if err != nil {
			return nil, err
		}
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to begin repeatable read delta transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var serverTime time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&serverTime); err != nil {
		return nil, fmt.Errorf("failed to read database clock for delta sync: %w", err)
	}
	serverTime = serverTime.UTC()

	// If any concurrent client write transaction is already active when our REPEATABLE READ snapshot
	// is established, clamp server_time slightly before its xact_start (bounded to 10s) so its
	// eventual commit will still satisfy updated_at > since on the client's next delta pull.
	var minActiveStart *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT MIN(xact_start)
		FROM pg_stat_activity
		WHERE datname = current_database()
		  AND state = 'active'
		  AND backend_type = 'client backend'
		  AND pid <> pg_backend_pid()
	`).Scan(&minActiveStart); err == nil && minActiveStart != nil {
		candidate := minActiveStart.UTC().Add(-time.Millisecond)
		floor := serverTime.Add(-10 * time.Second)
		if candidate.Before(floor) {
			candidate = floor
		}
		if candidate.Before(serverTime) {
			serverTime = candidate
		}
	}
	result.ServerTime = serverTime

	// 1. Fetch Collections
	var colQuery string
	var colParam uuid.UUID
	if workspaceID != nil {
		colQuery = `
			SELECT id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE workspace_id = $1 AND updated_at > $2
		`
		colParam = *workspaceID
	} else if projectID != nil {
		colQuery = `
			SELECT id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at, deleted_at
			FROM collections
			WHERE project_id = $1 AND updated_at > $2
		`
		colParam = *projectID
	} else {
		return nil, errors.New("must specify workspace_id or project_id")
	}

	colRows, err := tx.Query(ctx, colQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query collections delta: %w", err)
	}
	defer colRows.Close()

	for colRows.Next() {
		var c domain.Collection
		if err := colRows.Scan(
			&c.ID, &c.WorkspaceID, &c.ProjectID, &c.Name, &c.Description, &c.MinRole,
			&c.Version, &c.CreatedBy, &c.LastModifiedBy, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan collection delta: %w", err)
		}

		if projectID != nil && !user.IsSuperadmin() {
			if !CanAccessCollection(userRole, c.MinRole) {
				continue // Do NOT send protected collection to unauthorized user
			}
		}

		result.Collections = append(result.Collections, &c)
	}

	if err := colRows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read delta: %w", err)
	}
	colRows.Close()

	// 2. Fetch Items
	var itemQuery string
	if workspaceID != nil {
		itemQuery = `
			SELECT ci.id, ci.collection_id, ci.parent_id, ci.type, ci.name, ci.sort_order,
			       ci.method, ci.url, ci.params, ci.path_variables, ci.headers, ci.auth, ci.body_type, ci.raw_type,
			       ci.body_content, ci.graphql_query, ci.graphql_variables, ci.body_form_data,
			       ci.pre_request_script, ci.post_response_script, ci.examples, ci.version, ci.last_modified_by,
			       ci.created_at, ci.updated_at, ci.deleted_at, c.min_role
			FROM collection_items ci
			JOIN collections c ON ci.collection_id = c.id
			WHERE c.workspace_id = $1 AND ci.updated_at > $2
		`
	} else {
		itemQuery = `
			SELECT ci.id, ci.collection_id, ci.parent_id, ci.type, ci.name, ci.sort_order,
			       ci.method, ci.url, ci.params, ci.path_variables, ci.headers, ci.auth, ci.body_type, ci.raw_type,
			       ci.body_content, ci.graphql_query, ci.graphql_variables, ci.body_form_data,
			       ci.pre_request_script, ci.post_response_script, ci.examples, ci.version, ci.last_modified_by,
			       ci.created_at, ci.updated_at, ci.deleted_at, c.min_role
			FROM collection_items ci
			JOIN collections c ON ci.collection_id = c.id
			WHERE c.project_id = $1 AND ci.updated_at > $2
		`
	}

	itemRows, err := tx.Query(ctx, itemQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query item deltas: %w", err)
	}
	defer itemRows.Close()

	for itemRows.Next() {
		var item domain.CollectionItem
		var typeStr string
		var colMinRole domain.ProjectRole
		if err := itemRows.Scan(
			&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
			&item.Method, &item.URL, &item.Params, &item.PathVariables, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
			&item.BodyContent, &item.GraphQLQuery, &item.GraphQLVariables, &item.BodyFormData,
			&item.PreRequestScript, &item.PostResponseScript, &item.Examples, &item.Version, &item.LastModifiedBy,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt, &colMinRole,
		); err != nil {
			return nil, fmt.Errorf("failed to scan item delta: %w", err)
		}

		if projectID != nil && !user.IsSuperadmin() {
			if !CanAccessCollection(userRole, colMinRole) {
				continue // Do NOT send item if collection is protected
			}
		}

		item.Type = domain.ItemType(typeStr)
		result.Items = append(result.Items, &item)
	}

	if err := itemRows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read delta: %w", err)
	}
	itemRows.Close()
	ApplySummaryModeToItems(result.Items)

	// 3. Fetch Environments
	var envQuery string
	if workspaceID != nil {
		envQuery = `
			SELECT id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE workspace_id = $1 AND updated_at > $2
		`
	} else {
		envQuery = `
			SELECT id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE project_id = $1 AND updated_at > $2
		`
	}

	envRows, err := tx.Query(ctx, envQuery, colParam, since)
	if err != nil {
		return nil, fmt.Errorf("failed to query environments delta: %w", err)
	}
	defer envRows.Close()
	// userRole was already computed above for projectRBAC if projectID != nil

	for envRows.Next() {
		var env domain.Environment
		if err := envRows.Scan(
			&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables, &env.MinRole,
			&env.Version, &env.LastModifiedBy, &env.CreatedAt, &env.UpdatedAt, &env.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan environment delta: %w", err)
		}

		if projectID != nil && !user.IsSuperadmin() {
			if !CanAccessEnv(userRole, env.MinRole) {
				continue // Do NOT send protected env to unauthorized user!
			}
		}

		result.Environments = append(result.Environments, &env)
	}

	if err := envRows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read delta: %w", err)
	}
	envRows.Close()

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit delta transaction: %w", err)
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
	Code       string    `json:"code,omitempty"`
	ServerData any       `json:"server_data,omitempty"`
}

type SyncPushResponse struct {
	AppliedIDs []uuid.UUID          `json:"applied_ids"`
	Conflicts  []SyncConflictReport `json:"conflicts"`
	ServerTime time.Time            `json:"server_time"`
}

const (
	// Leave space for the newline added by response.JSON and for future envelope
	// fields while keeping the push result below the identity transfer limit.
	MaxSyncPushResponseBytes    = 4<<20 - 1024
	maxSyncConflictMessageBytes = 1024
)

type syncPushEnvelope struct {
	Success bool              `json:"success"`
	Data    *SyncPushResponse `json:"data"`
}

// boundSyncPushResponse guarantees that a completed changeset can report every
// applied ID without requiring a post-write oversized-response error. Remote
// conflict data is optional and is omitted first because the client can pull
// the authoritative item again.
func boundSyncPushResponse(result *SyncPushResponse) {
	for index := range result.Conflicts {
		result.Conflicts[index].Message = truncateUTF8(result.Conflicts[index].Message, maxSyncConflictMessageBytes)
	}
	if syncPushResponseSize(result) <= MaxSyncPushResponseBytes {
		return
	}
	for index := range result.Conflicts {
		result.Conflicts[index].ServerData = nil
		if syncPushResponseSize(result) <= MaxSyncPushResponseBytes {
			return
		}
	}
}

func syncPushResponseSize(result *SyncPushResponse) int {
	encoded, err := json.Marshal(syncPushEnvelope{Success: true, Data: result})
	if err != nil {
		return MaxSyncPushResponseBytes + 1
	}
	return len(encoded)
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && value[end]&0xc0 == 0x80 {
		end--
	}
	return value[:end]
}

func isUniqueConstraintError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func sameSyncOptionalUUID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// PushChangeset processes a batch of offline mutations, applying non-conflicting mutations
// and returning detailed conflict reports for any stale updates.
func (s *SyncService) PushChangeset(ctx context.Context, user *domain.User, req SyncPushRequest) (*SyncPushResponse, error) {
	if len(req.Collections)+len(req.Items)+len(req.Environments) > MaxSyncMutations {
		return nil, ErrBatchLimit
	}
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
			} else if isUniqueConstraintError(err) && col.ID != uuid.Nil {
				if existing, getErr := s.collectionService.GetCollection(ctx, user, col.ID); getErr == nil &&
					sameSyncOptionalUUID(existing.WorkspaceID, col.WorkspaceID) &&
					sameSyncOptionalUUID(existing.ProjectID, col.ProjectID) {
					resp.AppliedIDs = append(resp.AppliedIDs, col.ID)
				} else {
					slog.Warn("sync push collection create conflict", "collection_id", col.ID, "error", err)
					resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
						ID:         col.ID,
						Type:       "collection",
						Message:    err.Error(),
						ServerData: existing,
					})
				}
			} else {
				slog.Warn("sync push collection create failed", "collection_id", col.ID, "error", err)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:      col.ID,
					Type:    "collection",
					Message: err.Error(),
				})
			}
		case "update":
			col := m.Collection
			updated, err := s.collectionService.UpdateCollection(ctx, user, &col, m.BaseVersion)
			if err != nil {
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:         col.ID,
					Type:       "collection",
					Message:    err.Error(),
					ServerData: updated,
				})
			} else {
				resp.AppliedIDs = append(resp.AppliedIDs, col.ID)
			}
		case "delete":
			if err := s.collectionService.DeleteCollection(ctx, user, m.Collection.ID); err == nil {
				resp.AppliedIDs = append(resp.AppliedIDs, m.Collection.ID)
			} else {
				conflict := SyncConflictReport{ID: m.Collection.ID, Type: "collection", Message: err.Error()}
				if errors.Is(err, ErrFeatureDisabled) {
					conflict.Code = "FEATURE_DISABLED"
				} else if errors.Is(err, ErrFeaturePolicyUnavailable) {
					conflict.Code = "FEATURE_POLICY_UNAVAILABLE"
				}
				resp.Conflicts = append(resp.Conflicts, conflict)
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
			} else if isUniqueConstraintError(err) && item.ID != uuid.Nil {
				if existing, getErr := s.collectionService.GetItem(ctx, user, item.ID); getErr == nil &&
					existing.CollectionID == item.CollectionID {
					resp.AppliedIDs = append(resp.AppliedIDs, item.ID)
				} else {
					slog.Warn("sync push item create conflict", "item_id", item.ID, "error", err)
					resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
						ID:         item.ID,
						Type:       "item",
						Message:    err.Error(),
						ServerData: existing,
					})
				}
			} else {
				slog.Warn("sync push item create failed", "item_id", item.ID, "error", err)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:      item.ID,
					Type:    "item",
					Message: err.Error(),
				})
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
			} else {
				slog.Warn("sync push item delete failed", "item_id", m.Item.ID, "error", err)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:      m.Item.ID,
					Type:    "item",
					Message: err.Error(),
				})
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
			} else if isUniqueConstraintError(err) && env.ID != uuid.Nil {
				if existing, getErr := s.envService.Get(ctx, user, env.ID); getErr == nil &&
					sameSyncOptionalUUID(existing.WorkspaceID, env.WorkspaceID) &&
					sameSyncOptionalUUID(existing.ProjectID, env.ProjectID) {
					resp.AppliedIDs = append(resp.AppliedIDs, env.ID)
				} else {
					slog.Warn("sync push environment create conflict", "environment_id", env.ID, "error", err)
					resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
						ID:         env.ID,
						Type:       "environment",
						Message:    err.Error(),
						ServerData: existing,
					})
				}
			} else {
				slog.Warn("sync push environment create failed", "environment_id", env.ID, "error", err)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:      env.ID,
					Type:    "environment",
					Message: err.Error(),
				})
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
			} else {
				slog.Warn("sync push environment delete failed", "environment_id", m.Environment.ID, "error", err)
				resp.Conflicts = append(resp.Conflicts, SyncConflictReport{
					ID:      m.Environment.ID,
					Type:    "environment",
					Message: err.Error(),
				})
			}
		}
	}

	boundSyncPushResponse(resp)
	return resp, nil
}

type ImportCollectionRequest struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Description *string             `json:"description,omitempty"`
	Items       []ImportItemRequest `json:"items,omitempty"`
}

type ImportItemRequest struct {
	ID                 string                 `json:"id"`
	ParentID           *string                `json:"parent_id,omitempty"`
	Type               string                 `json:"type"`
	Name               string                 `json:"name"`
	SortOrder          int                    `json:"sort_order"`
	Method             *string                `json:"method,omitempty"`
	URL                *string                `json:"url,omitempty"`
	Params             *json.RawMessage       `json:"params,omitempty"`
	PathVariables      *json.RawMessage       `json:"path_variables,omitempty"`
	Headers            *json.RawMessage       `json:"headers,omitempty"`
	Auth               *json.RawMessage       `json:"auth,omitempty"`
	BodyType           *string                `json:"body_type,omitempty"`
	RawType            *string                `json:"raw_type,omitempty"`
	BodyContent        *string                `json:"body_content,omitempty"`
	GraphQLQuery       *string                `json:"graphql_query,omitempty"`
	GraphQLVariables   *string                `json:"graphql_variables,omitempty"`
	BodyFormData       *json.RawMessage       `json:"body_form_data,omitempty"`
	PreRequestScript   *string                `json:"pre_request_script,omitempty"`
	PostResponseScript *string                `json:"post_response_script,omitempty"`
	Examples           domain.OptionalRawJSON `json:"examples,omitzero"`
	Items              []ImportItemRequest    `json:"items,omitempty"`
}

type ImportBatchResult struct {
	Message          string           `json:"message"`
	ImportedExamples int              `json:"imported_examples"`
	ItemVersions     map[string]int64 `json:"item_versions"`
}

type lockedImportCollection struct {
	workspaceID *uuid.UUID
	projectID   *uuid.UUID
	minRole     domain.ProjectRole
	deletedAt   *time.Time
}

func isRetryableSyncTxError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001")
}

// ImportBatchWithSummary claims and migrates offline collections and returns summary metadata.
func (s *SyncService) ImportBatchWithSummary(ctx context.Context, user *domain.User, workspaceID *uuid.UUID, projectID *uuid.UUID, collections []ImportCollectionRequest) (*ImportBatchResult, error) {
	if (workspaceID == nil) == (projectID == nil) {
		return nil, ErrInvalidScope
	}
	if err := validateImport(collections); err != nil {
		return nil, err
	}
	for _, colReq := range collections {
		if err := ValidateName(colReq.Name); err != nil {
			return nil, err
		}
	}

	candidateIDMap := make(map[string]struct{}, len(collections))
	candidateIDs := make([]string, 0, len(collections))
	for _, colReq := range collections {
		if parsed, err := uuid.Parse(colReq.ID); err == nil && parsed != uuid.Nil {
			idStr := parsed.String()
			if _, ok := candidateIDMap[idStr]; !ok {
				candidateIDMap[idStr] = struct{}{}
				candidateIDs = append(candidateIDs, idStr)
			}
		}
	}
	sort.Strings(candidateIDs)

	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		result, err := s.importBatchTxAttempt(ctx, user, workspaceID, projectID, collections, candidateIDs)
		if err == nil {
			return result, nil
		}
		if isRetryableSyncTxError(err) && attempt < maxAttempts-1 && ctx.Err() == nil {
			continue
		}
		return nil, err
	}
	return nil, ErrImportConflict
}

func (s *SyncService) importBatchTxAttempt(ctx context.Context, user *domain.User, workspaceID *uuid.UUID, projectID *uuid.UUID, collections []ImportCollectionRequest, candidateIDs []string) (*ImportBatchResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to start import transaction: %w", err)
	}
	defer tx.Rollback(ctx)
	role, err := authorizeImportScope(ctx, tx, user, workspaceID, projectID)
	if err != nil {
		return nil, err
	}

	lockedCols := make(map[uuid.UUID]lockedImportCollection, len(candidateIDs))
	if len(candidateIDs) > 0 {
		rows, err := tx.Query(ctx, "SELECT id, workspace_id, project_id, min_role, deleted_at FROM collections WHERE id = ANY($1::text[]::uuid[]) ORDER BY id ASC FOR UPDATE", candidateIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to inspect import collections: %w", err)
		}
		for rows.Next() {
			var id uuid.UUID
			var row lockedImportCollection
			if err := rows.Scan(&id, &row.workspaceID, &row.projectID, &row.minRole, &row.deletedAt); err != nil {
				rows.Close()
				return nil, fmt.Errorf("failed to scan import collection: %w", err)
			}
			lockedCols[id] = row
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("failed to iterate import collections: %w", err)
		}
		rows.Close()
	}

	result := &ImportBatchResult{
		Message:          "collections successfully imported into cloud scope",
		ImportedExamples: 0,
		ItemVersions:     make(map[string]int64),
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return nil, fmt.Errorf("failed to read database timestamp: %w", err)
	}
	now = now.UTC()

	seenColIDs := make(map[uuid.UUID]struct{}, len(collections))
	for _, colReq := range collections {
		colName := strings.TrimSpace(colReq.Name)
		colID, err := uuid.Parse(colReq.ID)
		exists := false
		if err != nil || colID == uuid.Nil {
			colID = uuid.New()
		} else if _, dup := seenColIDs[colID]; dup {
			colID = uuid.New()
		} else if existing, ok := lockedCols[colID]; ok {
			sameScope := (workspaceID != nil && existing.workspaceID != nil && *workspaceID == *existing.workspaceID) ||
				(projectID != nil && existing.projectID != nil && *projectID == *existing.projectID)
			if !sameScope {
				colID = uuid.New()
			} else {
				if existing.deletedAt != nil || !CanAccessCollection(role, existing.minRole) {
					return nil, ErrForbidden
				}
				exists = true
			}
		}
		seenColIDs[colID] = struct{}{}

		if exists {
			_, err = tx.Exec(ctx, `UPDATE collections SET name=$2, description=$3, version=version+1, last_modified_by=$4, updated_at=$5 WHERE id=$1`, colID, colName, colReq.Description, user.ID, now)
		} else {
			var affected int64
			res, insertErr := tx.Exec(ctx, `INSERT INTO collections (id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,'reader',1,$6,$6,$7,$7) ON CONFLICT (id) DO NOTHING`, colID, workspaceID, projectID, colName, colReq.Description, user.ID, now)
			err = insertErr
			if err == nil {
				affected = res.RowsAffected()
				if affected != 1 {
					return nil, ErrImportConflict
				}
			}
		}
		if err != nil {
			return nil, fmt.Errorf("failed to write imported collection: %w", err)
		}
		seenItemIDs := make(map[uuid.UUID]struct{})
		if err := s.insertImportItems(ctx, tx, colID, nil, colReq.Items, user.ID, now, result, seenItemIDs); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// ImportBatch allows claiming and migrating offline LocalStorage collections into user's workspace or project.
func (s *SyncService) ImportBatch(ctx context.Context, user *domain.User, workspaceID *uuid.UUID, projectID *uuid.UUID, collections []ImportCollectionRequest) error {
	_, err := s.ImportBatchWithSummary(ctx, user, workspaceID, projectID, collections)
	return err
}

func (s *SyncService) insertImportItems(
	ctx context.Context,
	tx pgx.Tx,
	colID uuid.UUID,
	parentID *uuid.UUID,
	items []ImportItemRequest,
	userID uuid.UUID,
	now time.Time,
	summary *ImportBatchResult,
	seenItemIDs map[uuid.UUID]struct{},
) error {
	for _, itemReq := range items {
		itemID, err := uuid.Parse(itemReq.ID)
		if err != nil || itemID == uuid.Nil {
			itemID = uuid.New()
		} else if _, dup := seenItemIDs[itemID]; dup {
			itemID = uuid.New()
		} else {
			// Check foreign collision without FOR UPDATE to avoid cross-collection lock contention.
			var existingColID uuid.UUID
			if err := tx.QueryRow(ctx, "SELECT collection_id FROM collection_items WHERE id = $1", itemID).Scan(&existingColID); err == nil {
				if existingColID != colID {
					itemID = uuid.New()
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("failed to inspect import item: %w", err)
			}
		}
		for _, dup := seenItemIDs[itemID]; dup; _, dup = seenItemIDs[itemID] {
			itemID = uuid.New()
		}
		seenItemIDs[itemID] = struct{}{}

		itemType := itemReq.Type
		if itemType == "" {
			itemType = "request"
		}

		hasExplicitExamples := itemReq.Examples.Present && !itemReq.Examples.IsNull
		examplesArg := "[]"
		importedCountForItem := 0
		if hasExplicitExamples && itemType == "request" {
			if len(itemReq.Examples.Raw) > 0 {
				examplesArg = string(itemReq.Examples.Raw)
				var list []domain.SavedExample
				if jsonErr := json.Unmarshal(itemReq.Examples.Raw, &list); jsonErr == nil {
					importedCountForItem = len(list)
				}
			}
		}

		insertItemQuery := `
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
				$23, $23
			)
			ON CONFLICT (id) DO UPDATE SET
				collection_id = EXCLUDED.collection_id,
				parent_id = EXCLUDED.parent_id,
				type = EXCLUDED.type,
				deleted_at = NULL,
				name = EXCLUDED.name,
				sort_order = EXCLUDED.sort_order,
				method = EXCLUDED.method,
				url = EXCLUDED.url,
				params = EXCLUDED.params,
				path_variables = EXCLUDED.path_variables,
				headers = EXCLUDED.headers,
				auth = EXCLUDED.auth,
				body_type = EXCLUDED.body_type,
				raw_type = EXCLUDED.raw_type,
				body_content = EXCLUDED.body_content,
				graphql_query = EXCLUDED.graphql_query,
				graphql_variables = EXCLUDED.graphql_variables,
				body_form_data = EXCLUDED.body_form_data,
				pre_request_script = EXCLUDED.pre_request_script,
				post_response_script = EXCLUDED.post_response_script,
				examples = CASE WHEN $24 THEN EXCLUDED.examples ELSE collection_items.examples END,
				version = collection_items.version + 1,
				last_modified_by = EXCLUDED.last_modified_by,
				updated_at = EXCLUDED.updated_at
			WHERE collection_items.collection_id = EXCLUDED.collection_id
			RETURNING version
		`

		var savedVersion int64
		err = tx.QueryRow(ctx, insertItemQuery,
			itemID, colID, parentID, itemType, strings.TrimSpace(itemReq.Name), itemReq.SortOrder,
			itemReq.Method, itemReq.URL, itemReq.Params, itemReq.PathVariables, itemReq.Headers, itemReq.Auth,
			itemReq.BodyType, itemReq.RawType, itemReq.BodyContent, itemReq.GraphQLQuery,
			itemReq.GraphQLVariables, itemReq.BodyFormData, itemReq.PreRequestScript,
			itemReq.PostResponseScript, examplesArg, userID, now, hasExplicitExamples,
		).Scan(&savedVersion)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrImportConflict
			}
			return fmt.Errorf("failed to import item %s: %w", itemReq.Name, err)
		}

		if summary != nil {
			summary.ImportedExamples += importedCountForItem
			summary.ItemVersions[itemID.String()] = savedVersion
		}
		if len(itemReq.Items) > 0 {
			if err := s.insertImportItems(ctx, tx, colID, &itemID, itemReq.Items, userID, now, summary, seenItemIDs); err != nil {
				return err
			}
		}
	}
	return nil
}
