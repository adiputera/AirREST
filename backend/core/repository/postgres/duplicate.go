package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	MaxDuplicateItems = 5000
	MaxDuplicateDepth = 32
	MaxDuplicateRunes = 150
	DuplicateSuffix   = " copy"
	ReceiptRetention  = 30 * 24 * time.Hour
)

var (
	ErrDuplicateForbidden  = errors.New("insufficient permission for duplicate operation")
	ErrDuplicateNotFound   = errors.New("source or target resource not found")
	ErrDuplicateValidation = errors.New("invalid duplicate request")
	ErrDuplicateLimit      = errors.New("duplicate exceeds item, depth, or size limit")
	ErrDuplicateConflict   = errors.New("duplicate operation conflict")
)

type DuplicateValidationError struct {
	Message string
}

func (e *DuplicateValidationError) Error() string { return e.Message }
func (e *DuplicateValidationError) Unwrap() error { return ErrDuplicateValidation }

type DuplicateLimitError struct {
	Message string
}

func (e *DuplicateLimitError) Error() string { return e.Message }
func (e *DuplicateLimitError) Unwrap() error { return ErrDuplicateLimit }

type DuplicateConflictError struct {
	Message string
}

func (e *DuplicateConflictError) Error() string { return e.Message }
func (e *DuplicateConflictError) Unwrap() error { return ErrDuplicateConflict }

type DuplicateCollectionReceipt struct {
	OperationID  uuid.UUID          `json:"operation_id"`
	Status       string             `json:"status"`
	CollectionID uuid.UUID          `json:"collection_id"`
	WorkspaceID  *uuid.UUID         `json:"workspace_id,omitempty"`
	ProjectID    *uuid.UUID         `json:"project_id,omitempty"`
	Name         string             `json:"name"`
	MinRole      domain.ProjectRole `json:"min_role"`
	Version      int64              `json:"version"`
	UpdatedAt    time.Time          `json:"updated_at"`
	ItemCount    int                `json:"item_count"`
}

type DuplicateItemReceipt struct {
	OperationID             uuid.UUID  `json:"operation_id"`
	Status                  string     `json:"status"`
	RootItemID              uuid.UUID  `json:"root_item_id"`
	TargetCollectionID      uuid.UUID  `json:"target_collection_id"`
	TargetParentID          *uuid.UUID `json:"target_parent_id,omitempty"`
	TargetCollectionVersion int64      `json:"target_collection_version"`
	Name                    string     `json:"name"`
	ItemCount               int        `json:"item_count"`
}

type DuplicateImportItem struct {
	Type               domain.ItemType
	Name               string
	SortOrder          int
	Method             *string
	URL                *string
	Params             *json.RawMessage
	PathVariables      *json.RawMessage
	Headers            *json.RawMessage
	Auth               *json.RawMessage
	BodyType           *string
	RawType            *string
	BodyContent        *string
	GraphQLQuery       *string
	GraphQLVariables   *string
	BodyFormData       *json.RawMessage
	PreRequestScript   *string
	PostResponseScript *string
	Items              []DuplicateImportItem
}

type DuplicateRepository struct {
	pool *pgxpool.Pool
}

func NewDuplicateRepository(pool *pgxpool.Pool) *DuplicateRepository {
	return &DuplicateRepository{pool: pool}
}

type scopeLockTarget struct {
	kind         string
	id           uuid.UUID
	requireWrite bool
}

func execDuplicateTxWithRetry(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin duplicate transaction: %w", err)
		}
		err = fn(tx)
		if err == nil {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				var pgErr *pgconn.PgError
				if errors.As(commitErr, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001") && attempt < maxAttempts-1 {
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-time.After(time.Duration(40*(attempt+1)) * time.Millisecond):
						continue
					}
				}
				return commitErr
			}
			return nil
		}
		_ = tx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001") && attempt < maxAttempts-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(40*(attempt+1)) * time.Millisecond):
				continue
			}
		}
		return err
	}
	return nil
}

func roleRankValue(role domain.ProjectRole) int {
	switch role {
	case domain.ProjectRoleAdmin:
		return 4
	case domain.ProjectRoleMaintainer:
		return 3
	case domain.ProjectRoleContributor:
		return 2
	case domain.ProjectRoleReader:
		return 1
	default:
		return 0
	}
}

func canAccessCollectionRole(userRole, minRole domain.ProjectRole) bool {
	minRank := roleRankValue(minRole)
	if minRank == 0 {
		minRank = 1
	}
	return roleRankValue(userRole) >= minRank
}

func clampMinRoleForTarget(sourceMinRole, targetRole domain.ProjectRole) domain.ProjectRole {
	if sourceMinRole == "" {
		sourceMinRole = domain.ProjectRoleReader
	}
	if canAccessCollectionRole(targetRole, sourceMinRole) {
		return sourceMinRole
	}
	if roleRankValue(targetRole) < 1 {
		return domain.ProjectRoleReader
	}
	return targetRole
}

func validateDuplicateRuneName(name string) (string, error) {
	if !utf8.ValidString(name) {
		return "", &DuplicateValidationError{Message: "name contains invalid UTF-8"}
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", &DuplicateValidationError{Message: "name is required"}
	}
	if utf8.RuneCountInString(trimmed) > MaxDuplicateRunes {
		return "", &DuplicateValidationError{Message: fmt.Sprintf("name exceeds maximum length of %d characters", MaxDuplicateRunes)}
	}
	return trimmed, nil
}

func resolveDuplicateContainerName(sourceName string, sameContainer bool) (string, error) {
	trimmed := strings.TrimSpace(sourceName)
	if sameContainer {
		trimmed += DuplicateSuffix
	}
	return validateDuplicateRuneName(trimmed)
}

// authorizeScopeInTx locks and authorizes a workspace or project strictly on the transaction connection.
func authorizeScopeInTx(
	ctx context.Context,
	tx pgx.Tx,
	user *domain.User,
	workspaceID, projectID *uuid.UUID,
	requireWrite bool,
) (domain.ProjectRole, error) {
	if (workspaceID == nil) == (projectID == nil) {
		return "", &DuplicateValidationError{Message: "exactly one of workspace_id or project_id is required"}
	}
	if workspaceID != nil {
		var ownerID uuid.UUID
		err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id = $1 FOR SHARE`, *workspaceID).Scan(&ownerID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", ErrDuplicateNotFound
			}
			return "", err
		}
		if !user.IsSuperadmin() && ownerID != user.ID {
			return "", ErrDuplicateForbidden
		}
		return domain.ProjectRoleAdmin, nil
	}

	var teamID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT team_id FROM projects WHERE id = $1 FOR SHARE`, *projectID).Scan(&teamID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDuplicateNotFound
		}
		return "", err
	}
	if user.IsSuperadmin() {
		return domain.ProjectRoleAdmin, nil
	}

	var teamRole string
	err = tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2 FOR SHARE`, teamID, user.ID).Scan(&teamRole)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDuplicateForbidden
		}
		return "", err
	}
	if teamRole == "admin" {
		return domain.ProjectRoleAdmin, nil
	}

	var role domain.ProjectRole
	err = tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE`, *projectID, user.ID).Scan(&role)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrDuplicateForbidden
		}
		return "", err
	}
	if requireWrite && !domain.HasPermission(domain.GetPermissionsForRole(role), domain.PermissionCollectionWrite) {
		return "", ErrDuplicateForbidden
	}
	return role, nil
}

// lockAndAuthorizeScopesInTx locks all distinct scopes in deterministic order to avoid lock inversion deadlocks.
func lockAndAuthorizeScopesInTx(
	ctx context.Context,
	tx pgx.Tx,
	user *domain.User,
	targets []scopeLockTarget,
) (map[string]domain.ProjectRole, error) {
	merged := make(map[string]scopeLockTarget)
	for _, t := range targets {
		key := t.kind + ":" + t.id.String()
		if prev, ok := merged[key]; ok {
			t.requireWrite = prev.requireWrite || t.requireWrite
		}
		merged[key] = t
	}
	ordered := make([]scopeLockTarget, 0, len(merged))
	for _, t := range merged {
		ordered = append(ordered, t)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].kind != ordered[j].kind {
			return ordered[i].kind < ordered[j].kind
		}
		return ordered[i].id.String() < ordered[j].id.String()
	})

	roles := make(map[string]domain.ProjectRole, len(ordered))
	for _, t := range ordered {
		var wsID, projID *uuid.UUID
		if t.kind == "workspace" {
			id := t.id
			wsID = &id
		} else {
			id := t.id
			projID = &id
		}
		role, err := authorizeScopeInTx(ctx, tx, user, wsID, projID, t.requireWrite)
		if err != nil {
			return nil, err
		}
		roles[t.kind+":"+t.id.String()] = role
	}
	return roles, nil
}

func scopeKey(wsID, projID *uuid.UUID) string {
	if wsID != nil {
		return "workspace:" + wsID.String()
	}
	if projID != nil {
		return "project:" + projID.String()
	}
	return ""
}

type ledgerRecord struct {
	Kind               string
	Fingerprint        string
	Status             string
	CreatedResourceID  *uuid.UUID
	TargetCollectionID *uuid.UUID
	TargetWorkspaceID  *uuid.UUID
	TargetProjectID    *uuid.UUID
	TargetParentID     *uuid.UUID
	ResultName         *string
	ResultMinRole      *string
	ResultVersion      *int64
	ItemCount          int
	CommittedAt        *time.Time
}

func reserveOrLoadOperationInTx(
	ctx context.Context,
	tx pgx.Tx,
	actorID, operationID uuid.UUID,
	kind, fingerprint string,
) (*ledgerRecord, bool, error) {
	res, err := tx.Exec(ctx, `
		INSERT INTO duplicate_operations (actor_id, operation_id, kind, fingerprint, status)
		VALUES ($1, $2, $3, $4, 'pending')
		ON CONFLICT (actor_id, operation_id) DO NOTHING
	`, actorID, operationID, kind, fingerprint)
	if err != nil {
		return nil, false, err
	}
	if res.RowsAffected() == 1 {
		return nil, true, nil
	}

	var rec ledgerRecord
	err = tx.QueryRow(ctx, `
		SELECT kind, fingerprint, status, created_resource_id, target_collection_id,
		       target_workspace_id, target_project_id, target_parent_id,
		       result_name, result_min_role, result_version, item_count, committed_at
		FROM duplicate_operations
		WHERE actor_id = $1 AND operation_id = $2
		FOR UPDATE
	`, actorID, operationID).Scan(
		&rec.Kind, &rec.Fingerprint, &rec.Status, &rec.CreatedResourceID, &rec.TargetCollectionID,
		&rec.TargetWorkspaceID, &rec.TargetProjectID, &rec.TargetParentID,
		&rec.ResultName, &rec.ResultMinRole, &rec.ResultVersion, &rec.ItemCount, &rec.CommittedAt,
	)
	if err != nil {
		return nil, false, err
	}
	if rec.Kind != kind || rec.Fingerprint != fingerprint {
		return nil, false, &DuplicateConflictError{Message: "operation_id has already been used for a different duplicate operation"}
	}
	return &rec, false, nil
}

func resolveCollectionReplayInTx(
	ctx context.Context,
	tx pgx.Tx,
	user *domain.User,
	operationID uuid.UUID,
	rec *ledgerRecord,
) (*DuplicateCollectionReceipt, error) {
	if rec.CreatedResourceID == nil {
		return nil, &DuplicateConflictError{Message: "duplicate operation is still pending"}
	}
	var col domain.Collection
	err := tx.QueryRow(ctx, `
		SELECT id, workspace_id, project_id, name, min_role, version, updated_at, deleted_at
		FROM collections
		WHERE id = $1
		FOR SHARE
	`, *rec.CreatedResourceID).Scan(
		&col.ID, &col.WorkspaceID, &col.ProjectID, &col.Name, &col.MinRole, &col.Version, &col.UpdatedAt, &col.DeletedAt,
	)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// Container missing; still re-verify actor's access to original target scope if available.
		if rec.TargetWorkspaceID != nil || rec.TargetProjectID != nil {
			if _, authErr := authorizeScopeInTx(ctx, tx, user, rec.TargetWorkspaceID, rec.TargetProjectID, false); authErr != nil {
				return nil, authErr
			}
		}
		name := ""
		if rec.ResultName != nil {
			name = *rec.ResultName
		}
		minRole := domain.ProjectRoleReader
		if rec.ResultMinRole != nil && *rec.ResultMinRole != "" {
			minRole = domain.ProjectRole(*rec.ResultMinRole)
		}
		version := int64(1)
		if rec.ResultVersion != nil {
			version = *rec.ResultVersion
		}
		updatedAt := time.Now().UTC()
		if rec.CommittedAt != nil {
			updatedAt = *rec.CommittedAt
		}
		return &DuplicateCollectionReceipt{
			OperationID:  operationID,
			Status:       "committed_deleted",
			CollectionID: *rec.CreatedResourceID,
			WorkspaceID:  rec.TargetWorkspaceID,
			ProjectID:    rec.TargetProjectID,
			Name:         name,
			MinRole:      minRole,
			Version:      version,
			UpdatedAt:    updatedAt,
			ItemCount:    rec.ItemCount,
		}, nil
	}

	role, authErr := authorizeScopeInTx(ctx, tx, user, col.WorkspaceID, col.ProjectID, false)
	if authErr != nil {
		return nil, authErr
	}
	if col.ProjectID != nil && !user.IsSuperadmin() && !canAccessCollectionRole(role, col.MinRole) {
		return nil, ErrDuplicateForbidden
	}
	status := "committed"
	if col.DeletedAt != nil {
		status = "committed_deleted"
	} else if rec.Status == "expired" {
		status = "expired_committed"
	}
	return &DuplicateCollectionReceipt{
		OperationID:  operationID,
		Status:       status,
		CollectionID: col.ID,
		WorkspaceID:  col.WorkspaceID,
		ProjectID:    col.ProjectID,
		Name:         col.Name,
		MinRole:      col.MinRole,
		Version:      col.Version,
		UpdatedAt:    col.UpdatedAt,
		ItemCount:    rec.ItemCount,
	}, nil
}

func resolveItemReplayInTx(
	ctx context.Context,
	tx pgx.Tx,
	user *domain.User,
	operationID uuid.UUID,
	rec *ledgerRecord,
) (*DuplicateItemReceipt, error) {
	if rec.CreatedResourceID == nil || rec.TargetCollectionID == nil {
		return nil, &DuplicateConflictError{Message: "duplicate operation is still pending"}
	}

	var itemColID uuid.UUID
	var itemParentID *uuid.UUID
	var itemName string
	var itemDeletedAt *time.Time
	itemErr := tx.QueryRow(ctx, `
		SELECT collection_id, parent_id, name, deleted_at
		FROM collection_items
		WHERE id = $1
		FOR SHARE
	`, *rec.CreatedResourceID).Scan(&itemColID, &itemParentID, &itemName, &itemDeletedAt)
	if itemErr != nil && !errors.Is(itemErr, pgx.ErrNoRows) {
		return nil, itemErr
	}

	checkColID := *rec.TargetCollectionID
	if itemErr == nil {
		checkColID = itemColID
	}

	var col domain.Collection
	colErr := tx.QueryRow(ctx, `
		SELECT id, workspace_id, project_id, min_role, version, deleted_at
		FROM collections
		WHERE id = $1
		FOR SHARE
	`, checkColID).Scan(&col.ID, &col.WorkspaceID, &col.ProjectID, &col.MinRole, &col.Version, &col.DeletedAt)
	if colErr != nil && !errors.Is(colErr, pgx.ErrNoRows) {
		return nil, colErr
	}

	if colErr == nil {
		role, authErr := authorizeScopeInTx(ctx, tx, user, col.WorkspaceID, col.ProjectID, false)
		if authErr != nil {
			return nil, authErr
		}
		if col.ProjectID != nil && !user.IsSuperadmin() && !canAccessCollectionRole(role, col.MinRole) {
			return nil, ErrDuplicateForbidden
		}
	} else if rec.TargetWorkspaceID != nil || rec.TargetProjectID != nil {
		if _, authErr := authorizeScopeInTx(ctx, tx, user, rec.TargetWorkspaceID, rec.TargetProjectID, false); authErr != nil {
			return nil, authErr
		}
	}

	status := "committed"
	if errors.Is(itemErr, pgx.ErrNoRows) || errors.Is(colErr, pgx.ErrNoRows) || itemDeletedAt != nil || col.DeletedAt != nil {
		status = "committed_deleted"
	} else if rec.Status == "expired" {
		status = "expired_committed"
	}

	name := itemName
	if name == "" && rec.ResultName != nil {
		name = *rec.ResultName
	}
	parentID := itemParentID
	if itemErr != nil {
		parentID = rec.TargetParentID
	}
	colVersion := col.Version
	if colErr != nil && rec.ResultVersion != nil {
		colVersion = *rec.ResultVersion
	}

	return &DuplicateItemReceipt{
		OperationID:             operationID,
		Status:                  status,
		RootItemID:              *rec.CreatedResourceID,
		TargetCollectionID:      checkColID,
		TargetParentID:          parentID,
		TargetCollectionVersion: colVersion,
		Name:                    name,
		ItemCount:               rec.ItemCount,
	}, nil
}

func (r *DuplicateRepository) DuplicateCollection(
	ctx context.Context,
	user *domain.User,
	sourceCollectionID uuid.UUID,
	targetWorkspaceID, targetProjectID *uuid.UUID,
	operationID uuid.UUID,
	fingerprint string,
) (*DuplicateCollectionReceipt, error) {
	if (targetWorkspaceID == nil) == (targetProjectID == nil) {
		return nil, &DuplicateValidationError{Message: "exactly one of target_workspace_id or target_project_id is required"}
	}

	var receipt *DuplicateCollectionReceipt
	err := execDuplicateTxWithRetry(ctx, r.pool, func(tx pgx.Tx) error {
		rec, isNew, err := reserveOrLoadOperationInTx(ctx, tx, user.ID, operationID, "collection", fingerprint)
		if err != nil {
			return err
		}
		if !isNew {
			replay, err := resolveCollectionReplayInTx(ctx, tx, user, operationID, rec)
			if err != nil {
				return err
			}
			receipt = replay
			return nil
		}

		// Pre-inspect source collection scope inside tx, then acquire sorted scope locks before locking collection rows.
		var preWsID, preProjID *uuid.UUID
		var preDeletedAt *time.Time
		err = tx.QueryRow(ctx, `SELECT workspace_id, project_id, deleted_at FROM collections WHERE id = $1`, sourceCollectionID).Scan(&preWsID, &preProjID, &preDeletedAt)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrDuplicateNotFound
			}
			return err
		}
		if preDeletedAt != nil {
			return ErrDuplicateNotFound
		}
		if preProjID != nil && targetWorkspaceID != nil {
			return ErrDuplicateForbidden
		}

		var targets []scopeLockTarget
		if preWsID != nil {
			targets = append(targets, scopeLockTarget{kind: "workspace", id: *preWsID, requireWrite: true})
		} else if preProjID != nil {
			targets = append(targets, scopeLockTarget{kind: "project", id: *preProjID, requireWrite: true})
		}
		if targetWorkspaceID != nil {
			targets = append(targets, scopeLockTarget{kind: "workspace", id: *targetWorkspaceID, requireWrite: true})
		} else if targetProjectID != nil {
			targets = append(targets, scopeLockTarget{kind: "project", id: *targetProjectID, requireWrite: true})
		}

		roles, err := lockAndAuthorizeScopesInTx(ctx, tx, user, targets)
		if err != nil {
			return err
		}

		var sourceCol domain.Collection
		err = tx.QueryRow(ctx, `
			SELECT id, workspace_id, project_id, name, description, min_role, version, deleted_at
			FROM collections
			WHERE id = $1
			FOR UPDATE
		`, sourceCollectionID).Scan(
			&sourceCol.ID, &sourceCol.WorkspaceID, &sourceCol.ProjectID, &sourceCol.Name,
			&sourceCol.Description, &sourceCol.MinRole, &sourceCol.Version, &sourceCol.DeletedAt,
		)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrDuplicateNotFound
			}
			return err
		}
		if sourceCol.DeletedAt != nil {
			return ErrDuplicateNotFound
		}
		if sourceCol.ProjectID != nil && targetWorkspaceID != nil {
			return ErrDuplicateForbidden
		}
		if !sameOptionalUUID(preWsID, sourceCol.WorkspaceID) || !sameOptionalUUID(preProjID, sourceCol.ProjectID) {
			return &DuplicateConflictError{Message: "source collection location changed concurrently; refresh and retry"}
		}

		sourceRole := roles[scopeKey(sourceCol.WorkspaceID, sourceCol.ProjectID)]
		if sourceCol.ProjectID != nil && !user.IsSuperadmin() && !canAccessCollectionRole(sourceRole, sourceCol.MinRole) {
			return ErrDuplicateForbidden
		}

		targetRole := roles[scopeKey(targetWorkspaceID, targetProjectID)]
		effectiveMinRole := sourceCol.MinRole
		if effectiveMinRole == "" {
			effectiveMinRole = domain.ProjectRoleReader
		}
		if targetProjectID != nil {
			if user.IsSuperadmin() {
				effectiveMinRole = sourceCol.MinRole
				if effectiveMinRole == "" {
					effectiveMinRole = domain.ProjectRoleReader
				}
			} else {
				effectiveMinRole = clampMinRoleForTarget(effectiveMinRole, targetRole)
			}
		}

		sameContainer := sameOptionalUUID(sourceCol.WorkspaceID, targetWorkspaceID) && sameOptionalUUID(sourceCol.ProjectID, targetProjectID)
		newName, err := resolveDuplicateContainerName(sourceCol.Name, sameContainer)
		if err != nil {
			return err
		}

		activeItems, err := loadActiveCollectionItemsInTx(ctx, tx, sourceCol.ID)
		if err != nil {
			return err
		}

		clonedRows, err := buildClonedCollectionTree(activeItems, nil, 0, true)
		if err != nil {
			return err
		}

		now := time.Now().UTC()
		newColID := uuid.New()
		_, err = tx.Exec(ctx, `
			INSERT INTO collections (id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, $8, $8)
		`, newColID, targetWorkspaceID, targetProjectID, newName, sourceCol.Description, effectiveMinRole, user.ID, now)
		if err != nil {
			return fmt.Errorf("failed to insert duplicated collection: %w", err)
		}

		if err := insertClonedItemsInTx(ctx, tx, newColID, clonedRows, user.ID, now); err != nil {
			return err
		}

		itemCount := len(clonedRows)
		expiresAt := now.Add(ReceiptRetention)
		_, err = tx.Exec(ctx, `
			UPDATE duplicate_operations
			SET status = 'committed',
			    created_resource_id = $3,
			    target_collection_id = $3,
			    target_workspace_id = $4,
			    target_project_id = $5,
			    result_name = $6,
			    result_min_role = $7,
			    result_version = 1,
			    item_count = $8,
			    committed_at = $9,
			    receipt_expires_at = $10,
			    updated_at = $9
			WHERE actor_id = $1 AND operation_id = $2
		`, user.ID, operationID, newColID, targetWorkspaceID, targetProjectID, newName, string(effectiveMinRole), itemCount, now, expiresAt)
		if err != nil {
			return err
		}

		receipt = &DuplicateCollectionReceipt{
			OperationID:  operationID,
			Status:       "committed",
			CollectionID: newColID,
			WorkspaceID:  targetWorkspaceID,
			ProjectID:    targetProjectID,
			Name:         newName,
			MinRole:      effectiveMinRole,
			Version:      1,
			UpdatedAt:    now,
			ItemCount:    itemCount,
		}
		return nil
	})
	return receipt, err
}

func (r *DuplicateRepository) ImportDuplicateCollection(
	ctx context.Context,
	user *domain.User,
	targetWorkspaceID, targetProjectID *uuid.UUID,
	operationID uuid.UUID,
	fingerprint string,
	name string,
	description *string,
	items []DuplicateImportItem,
) (*DuplicateCollectionReceipt, error) {
	if (targetWorkspaceID == nil) == (targetProjectID == nil) {
		return nil, &DuplicateValidationError{Message: "exactly one of target_workspace_id or target_project_id is required"}
	}
	validName, err := validateDuplicateRuneName(name)
	if err != nil {
		return nil, err
	}
	flatRows, err := flattenImportDuplicateItems(items)
	if err != nil {
		return nil, err
	}

	var receipt *DuplicateCollectionReceipt
	err = execDuplicateTxWithRetry(ctx, r.pool, func(tx pgx.Tx) error {
		rec, isNew, err := reserveOrLoadOperationInTx(ctx, tx, user.ID, operationID, "import_duplicate", fingerprint)
		if err != nil {
			return err
		}
		if !isNew {
			replay, err := resolveCollectionReplayInTx(ctx, tx, user, operationID, rec)
			if err != nil {
				return err
			}
			receipt = replay
			return nil
		}

		if _, err := authorizeScopeInTx(ctx, tx, user, targetWorkspaceID, targetProjectID, true); err != nil {
			return err
		}

		now := time.Now().UTC()
		newColID := uuid.New()
		minRole := domain.ProjectRoleReader
		_, err = tx.Exec(ctx, `
			INSERT INTO collections (id, workspace_id, project_id, name, description, min_role, version, created_by, last_modified_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, $8, $8)
		`, newColID, targetWorkspaceID, targetProjectID, validName, description, minRole, user.ID, now)
		if err != nil {
			return fmt.Errorf("failed to insert imported duplicate collection: %w", err)
		}

		if err := insertClonedItemsInTx(ctx, tx, newColID, flatRows, user.ID, now); err != nil {
			return err
		}

		itemCount := len(flatRows)
		expiresAt := now.Add(ReceiptRetention)
		_, err = tx.Exec(ctx, `
			UPDATE duplicate_operations
			SET status = 'committed',
			    created_resource_id = $3,
			    target_collection_id = $3,
			    target_workspace_id = $4,
			    target_project_id = $5,
			    result_name = $6,
			    result_min_role = $7,
			    result_version = 1,
			    item_count = $8,
			    committed_at = $9,
			    receipt_expires_at = $10,
			    updated_at = $9
			WHERE actor_id = $1 AND operation_id = $2
		`, user.ID, operationID, newColID, targetWorkspaceID, targetProjectID, validName, string(minRole), itemCount, now, expiresAt)
		if err != nil {
			return err
		}

		receipt = &DuplicateCollectionReceipt{
			OperationID:  operationID,
			Status:       "committed",
			CollectionID: newColID,
			WorkspaceID:  targetWorkspaceID,
			ProjectID:    targetProjectID,
			Name:         validName,
			MinRole:      minRole,
			Version:      1,
			UpdatedAt:    now,
			ItemCount:    itemCount,
		}
		return nil
	})
	return receipt, err
}

func (r *DuplicateRepository) DuplicateItem(
	ctx context.Context,
	user *domain.User,
	itemID, sourceCollectionID, targetCollectionID uuid.UUID,
	targetParentID *uuid.UUID,
	operationID uuid.UUID,
	fingerprint string,
) (*DuplicateItemReceipt, error) {
	var receipt *DuplicateItemReceipt
	err := execDuplicateTxWithRetry(ctx, r.pool, func(tx pgx.Tx) error {
		rec, isNew, err := reserveOrLoadOperationInTx(ctx, tx, user.ID, operationID, "item", fingerprint)
		if err != nil {
			return err
		}
		if !isNew {
			replay, err := resolveItemReplayInTx(ctx, tx, user, operationID, rec)
			if err != nil {
				return err
			}
			receipt = replay
			return nil
		}

		// Pre-inspect source & target collection scopes in tx before locking scope memberships in order.
		type colScope struct {
			id        uuid.UUID
			wsID      *uuid.UUID
			projID    *uuid.UUID
			deletedAt *time.Time
		}
		colIDs := []uuid.UUID{sourceCollectionID}
		if targetCollectionID != sourceCollectionID {
			colIDs = append(colIDs, targetCollectionID)
		}
		rows, err := tx.Query(ctx, `SELECT id, workspace_id, project_id, deleted_at FROM collections WHERE id = ANY($1)`, colIDs)
		if err != nil {
			return err
		}
		preScopes := make(map[uuid.UUID]colScope, len(colIDs))
		for rows.Next() {
			var cs colScope
			if err := rows.Scan(&cs.id, &cs.wsID, &cs.projID, &cs.deletedAt); err != nil {
				rows.Close()
				return err
			}
			preScopes[cs.id] = cs
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		preSrc, okSrc := preScopes[sourceCollectionID]
		preTgt, okTgt := preScopes[targetCollectionID]
		if !okSrc || !okTgt || preSrc.deletedAt != nil || preTgt.deletedAt != nil {
			return ErrDuplicateNotFound
		}
		if !sameOptionalUUID(preSrc.wsID, preTgt.wsID) || !sameOptionalUUID(preSrc.projID, preTgt.projID) {
			return &DuplicateValidationError{Message: "source and target collections must belong to the same workspace or project"}
		}

		var targets []scopeLockTarget
		if preSrc.wsID != nil {
			targets = append(targets, scopeLockTarget{kind: "workspace", id: *preSrc.wsID, requireWrite: true})
		} else if preSrc.projID != nil {
			targets = append(targets, scopeLockTarget{kind: "project", id: *preSrc.projID, requireWrite: true})
		}
		roles, err := lockAndAuthorizeScopesInTx(ctx, tx, user, targets)
		if err != nil {
			return err
		}

		// Lock collections in deterministic UUID order.
		lockRows, err := tx.Query(ctx, `
			SELECT id, workspace_id, project_id, min_role, version, deleted_at
			FROM collections
			WHERE id = ANY($1)
			ORDER BY id FOR UPDATE
		`, colIDs)
		if err != nil {
			return err
		}
		lockedCols := make(map[uuid.UUID]domain.Collection, len(colIDs))
		for lockRows.Next() {
			var c domain.Collection
			if err := lockRows.Scan(&c.ID, &c.WorkspaceID, &c.ProjectID, &c.MinRole, &c.Version, &c.DeletedAt); err != nil {
				lockRows.Close()
				return err
			}
			lockedCols[c.ID] = c
		}
		if err := lockRows.Err(); err != nil {
			lockRows.Close()
			return err
		}
		lockRows.Close()

		srcCol, okSrc := lockedCols[sourceCollectionID]
		tgtCol, okTgt := lockedCols[targetCollectionID]
		if !okSrc || !okTgt || srcCol.DeletedAt != nil || tgtCol.DeletedAt != nil {
			return ErrDuplicateNotFound
		}
		if !sameOptionalUUID(srcCol.WorkspaceID, preSrc.wsID) || !sameOptionalUUID(srcCol.ProjectID, preSrc.projID) ||
			!sameOptionalUUID(tgtCol.WorkspaceID, preTgt.wsID) || !sameOptionalUUID(tgtCol.ProjectID, preTgt.projID) {
			return &DuplicateConflictError{Message: "collection scope changed concurrently; refresh and retry"}
		}
		if !sameOptionalUUID(srcCol.WorkspaceID, tgtCol.WorkspaceID) || !sameOptionalUUID(srcCol.ProjectID, tgtCol.ProjectID) {
			return &DuplicateValidationError{Message: "source and target collections must belong to the same workspace or project"}
		}

		role := roles[scopeKey(srcCol.WorkspaceID, srcCol.ProjectID)]
		if srcCol.ProjectID != nil && !user.IsSuperadmin() {
			if !canAccessCollectionRole(role, srcCol.MinRole) || !canAccessCollectionRole(role, tgtCol.MinRole) {
				return ErrDuplicateForbidden
			}
		}

		sourceItems, err := loadActiveCollectionItemsInTx(ctx, tx, srcCol.ID)
		if err != nil {
			return err
		}
		targetItems := sourceItems
		if tgtCol.ID != srcCol.ID {
			targetItems, err = loadActiveCollectionItemsInTx(ctx, tx, tgtCol.ID)
			if err != nil {
				return err
			}
		}

		var rootItem *domain.CollectionItem
		for _, it := range sourceItems {
			if it.ID == itemID {
				rootItem = it
				break
			}
		}
		if rootItem == nil {
			return ErrDuplicateNotFound
		}

		targetParentDepth, err := computeParentDepth(targetItems, targetParentID)
		if err != nil {
			return err
		}

		sameCollection := srcCol.ID == tgtCol.ID
		newRootName, err := resolveDuplicateContainerName(rootItem.Name, sameCollection)
		if err != nil {
			return err
		}

		maxSiblingSort := -1
		for _, it := range targetItems {
			if sameOptionalUUID(it.ParentID, targetParentID) && it.SortOrder > maxSiblingSort {
				maxSiblingSort = it.SortOrder
			}
		}

		clonedRows, err := buildClonedSubtree(sourceItems, rootItem, targetParentID, newRootName, maxSiblingSort+1, targetParentDepth)
		if err != nil {
			return err
		}

		now := time.Now().UTC()
		if err := insertClonedItemsInTx(ctx, tx, tgtCol.ID, clonedRows, user.ID, now); err != nil {
			return err
		}

		var newTargetVersion int64
		err = tx.QueryRow(ctx, `
			UPDATE collections
			SET version = version + 1, updated_at = $1, last_modified_by = $2
			WHERE id = $3 AND deleted_at IS NULL
			RETURNING version
		`, now, user.ID, tgtCol.ID).Scan(&newTargetVersion)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrDuplicateNotFound
			}
			return err
		}

		newRootID := clonedRows[0].newID
		itemCount := len(clonedRows)
		expiresAt := now.Add(ReceiptRetention)
		_, err = tx.Exec(ctx, `
			UPDATE duplicate_operations
			SET status = 'committed',
			    created_resource_id = $3,
			    target_collection_id = $4,
			    target_workspace_id = $5,
			    target_project_id = $6,
			    target_parent_id = $7,
			    result_name = $8,
			    result_version = $9,
			    item_count = $10,
			    committed_at = $11,
			    receipt_expires_at = $12,
			    updated_at = $11
			WHERE actor_id = $1 AND operation_id = $2
		`, user.ID, operationID, newRootID, tgtCol.ID, tgtCol.WorkspaceID, tgtCol.ProjectID, targetParentID, newRootName, newTargetVersion, itemCount, now, expiresAt)
		if err != nil {
			return err
		}

		receipt = &DuplicateItemReceipt{
			OperationID:             operationID,
			Status:                  "committed",
			RootItemID:              newRootID,
			TargetCollectionID:      tgtCol.ID,
			TargetParentID:          targetParentID,
			TargetCollectionVersion: newTargetVersion,
			Name:                    newRootName,
			ItemCount:               itemCount,
		}
		return nil
	})
	return receipt, err
}

func loadActiveCollectionItemsInTx(ctx context.Context, tx pgx.Tx, collectionID uuid.UUID) ([]*domain.CollectionItem, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, collection_id, parent_id, type, name, sort_order,
		       method, url, params, path_variables, headers, auth, body_type, raw_type,
		       body_content, graphql_query, graphql_variables, body_form_data,
		       pre_request_script, post_response_script
		FROM collection_items
		WHERE collection_id = $1 AND deleted_at IS NULL
		ORDER BY sort_order ASC, created_at ASC
	`, collectionID)
	if err != nil {
		return nil, fmt.Errorf("failed to load collection items: %w", err)
	}
	defer rows.Close()

	items := make([]*domain.CollectionItem, 0)
	for rows.Next() {
		var it domain.CollectionItem
		var typeStr string
		if err := rows.Scan(
			&it.ID, &it.CollectionID, &it.ParentID, &typeStr, &it.Name, &it.SortOrder,
			&it.Method, &it.URL, &it.Params, &it.PathVariables, &it.Headers, &it.Auth, &it.BodyType, &it.RawType,
			&it.BodyContent, &it.GraphQLQuery, &it.GraphQLVariables, &it.BodyFormData,
			&it.PreRequestScript, &it.PostResponseScript,
		); err != nil {
			return nil, fmt.Errorf("failed to scan collection item: %w", err)
		}
		it.Type = domain.ItemType(typeStr)
		items = append(items, &it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func computeParentDepth(targetItems []*domain.CollectionItem, targetParentID *uuid.UUID) (int, error) {
	if targetParentID == nil {
		return 0, nil
	}
	byID := make(map[uuid.UUID]*domain.CollectionItem, len(targetItems))
	for _, it := range targetItems {
		byID[it.ID] = it
	}
	parent, ok := byID[*targetParentID]
	if !ok || parent.Type != domain.ItemTypeFolder {
		return 0, &DuplicateValidationError{Message: "target_parent_id folder not found in target collection"}
	}

	depth := 0
	visited := make(map[uuid.UUID]struct{})
	curr := parent
	for curr != nil {
		if _, seen := visited[curr.ID]; seen {
			return 0, &DuplicateValidationError{Message: "corrupted folder hierarchy in target collection"}
		}
		visited[curr.ID] = struct{}{}
		if curr.Type != domain.ItemTypeFolder {
			return 0, &DuplicateValidationError{Message: "target parent chain contains a non-folder item"}
		}
		depth++
		if depth > MaxDuplicateDepth {
			return 0, &DuplicateLimitError{Message: fmt.Sprintf("target folder exceeds maximum depth of %d levels", MaxDuplicateDepth)}
		}
		if curr.ParentID == nil {
			break
		}
		next, exists := byID[*curr.ParentID]
		if !exists {
			return 0, &DuplicateValidationError{Message: "target folder has missing ancestor"}
		}
		curr = next
	}
	return depth, nil
}

type clonedItemRow struct {
	newID              uuid.UUID
	newParentID        *uuid.UUID
	itemType           domain.ItemType
	name               string
	sortOrder          int
	method             *string
	url                *string
	params             *json.RawMessage
	pathVariables      *json.RawMessage
	headers            *json.RawMessage
	auth               *json.RawMessage
	bodyType           *string
	rawType            *string
	bodyContent        *string
	graphqlQuery       *string
	graphqlVariables   *string
	bodyFormData       *json.RawMessage
	preRequestScript   *string
	postResponseScript *string
}

func buildClonedCollectionTree(
	sourceItems []*domain.CollectionItem,
	rootParentOverride *uuid.UUID,
	baseDepth int,
	validateDescendantNames bool,
) ([]clonedItemRow, error) {
	childrenMap := make(map[string][]*domain.CollectionItem)
	for _, it := range sourceItems {
		key := ""
		if it.ParentID != nil {
			key = it.ParentID.String()
		}
		childrenMap[key] = append(childrenMap[key], it)
	}

	var result []clonedItemRow
	visited := make(map[uuid.UUID]struct{})
	var walk func(parentOldID string, newParentID *uuid.UUID, depth int) error
	walk = func(parentOldID string, newParentID *uuid.UUID, depth int) error {
		children := childrenMap[parentOldID]
		if len(children) == 0 {
			return nil
		}
		if depth > MaxDuplicateDepth {
			return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum folder depth of %d levels", MaxDuplicateDepth)}
		}
		for _, ch := range children {
			if _, seen := visited[ch.ID]; seen {
				return &DuplicateValidationError{Message: "circular item hierarchy detected in source collection"}
			}
			visited[ch.ID] = struct{}{}
			if len(result)+1 > MaxDuplicateItems {
				return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum limit of %d items", MaxDuplicateItems)}
			}
			name := ch.Name
			if validateDescendantNames {
				validName, err := validateDuplicateRuneName(ch.Name)
				if err != nil {
					return err
				}
				name = validName
			}
			newID := uuid.New()
			result = append(result, clonedItemRow{
				newID:              newID,
				newParentID:        newParentID,
				itemType:           ch.Type,
				name:               name,
				sortOrder:          ch.SortOrder,
				method:             ch.Method,
				url:                ch.URL,
				params:             ch.Params,
				pathVariables:      ch.PathVariables,
				headers:            ch.Headers,
				auth:               ch.Auth,
				bodyType:           ch.BodyType,
				rawType:            ch.RawType,
				bodyContent:        ch.BodyContent,
				graphqlQuery:       ch.GraphQLQuery,
				graphqlVariables:   ch.GraphQLVariables,
				bodyFormData:       ch.BodyFormData,
				preRequestScript:   ch.PreRequestScript,
				postResponseScript: ch.PostResponseScript,
			})
			if ch.Type == domain.ItemTypeFolder {
				pid := newID
				if err := walk(ch.ID.String(), &pid, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := walk("", rootParentOverride, baseDepth+1); err != nil {
		return nil, err
	}
	return result, nil
}

func buildClonedSubtree(
	sourceItems []*domain.CollectionItem,
	rootItem *domain.CollectionItem,
	targetParentID *uuid.UUID,
	newRootName string,
	rootSortOrder int,
	targetParentDepth int,
) ([]clonedItemRow, error) {
	if targetParentDepth+1 > MaxDuplicateDepth {
		return nil, &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum folder depth of %d levels", MaxDuplicateDepth)}
	}
	childrenMap := make(map[uuid.UUID][]*domain.CollectionItem)
	for _, it := range sourceItems {
		if it.ParentID != nil {
			childrenMap[*it.ParentID] = append(childrenMap[*it.ParentID], it)
		}
	}

	visited := map[uuid.UUID]struct{}{rootItem.ID: {}}
	rootNewID := uuid.New()
	result := []clonedItemRow{{
		newID:              rootNewID,
		newParentID:        targetParentID,
		itemType:           rootItem.Type,
		name:               newRootName,
		sortOrder:          rootSortOrder,
		method:             rootItem.Method,
		url:                rootItem.URL,
		params:             rootItem.Params,
		pathVariables:      rootItem.PathVariables,
		headers:            rootItem.Headers,
		auth:               rootItem.Auth,
		bodyType:           rootItem.BodyType,
		rawType:            rootItem.RawType,
		bodyContent:        rootItem.BodyContent,
		graphqlQuery:       rootItem.GraphQLQuery,
		graphqlVariables:   rootItem.GraphQLVariables,
		bodyFormData:       rootItem.BodyFormData,
		preRequestScript:   rootItem.PreRequestScript,
		postResponseScript: rootItem.PostResponseScript,
	}}

	var walk func(oldParentID, newParentID uuid.UUID, depth int) error
	walk = func(oldParentID, newParentID uuid.UUID, depth int) error {
		children := childrenMap[oldParentID]
		if len(children) == 0 {
			return nil
		}
		if depth > MaxDuplicateDepth {
			return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum folder depth of %d levels", MaxDuplicateDepth)}
		}
		for _, ch := range children {
			if _, seen := visited[ch.ID]; seen {
				return &DuplicateValidationError{Message: "circular item hierarchy detected in source subtree"}
			}
			visited[ch.ID] = struct{}{}
			if len(result)+1 > MaxDuplicateItems {
				return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum limit of %d items", MaxDuplicateItems)}
			}
			validName, err := validateDuplicateRuneName(ch.Name)
			if err != nil {
				return err
			}
			newID := uuid.New()
			pid := newParentID
			result = append(result, clonedItemRow{
				newID:              newID,
				newParentID:        &pid,
				itemType:           ch.Type,
				name:               validName,
				sortOrder:          ch.SortOrder,
				method:             ch.Method,
				url:                ch.URL,
				params:             ch.Params,
				pathVariables:      ch.PathVariables,
				headers:            ch.Headers,
				auth:               ch.Auth,
				bodyType:           ch.BodyType,
				rawType:            ch.RawType,
				bodyContent:        ch.BodyContent,
				graphqlQuery:       ch.GraphQLQuery,
				graphqlVariables:   ch.GraphQLVariables,
				bodyFormData:       ch.BodyFormData,
				preRequestScript:   ch.PreRequestScript,
				postResponseScript: ch.PostResponseScript,
			})
			if ch.Type == domain.ItemTypeFolder {
				if err := walk(ch.ID, newID, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if rootItem.Type == domain.ItemTypeFolder {
		if err := walk(rootItem.ID, rootNewID, targetParentDepth+2); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func flattenImportDuplicateItems(items []DuplicateImportItem) ([]clonedItemRow, error) {
	var result []clonedItemRow
	var walk func(list []DuplicateImportItem, parentID *uuid.UUID, depth int) error
	walk = func(list []DuplicateImportItem, parentID *uuid.UUID, depth int) error {
		if len(list) == 0 {
			return nil
		}
		if depth > MaxDuplicateDepth {
			return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum folder depth of %d levels", MaxDuplicateDepth)}
		}
		for idx, it := range list {
			if len(result)+1 > MaxDuplicateItems {
				return &DuplicateLimitError{Message: fmt.Sprintf("duplicate exceeds maximum limit of %d items", MaxDuplicateItems)}
			}
			validName, err := validateDuplicateRuneName(it.Name)
			if err != nil {
				return err
			}
			itemType := it.Type
			if itemType == "" {
				itemType = domain.ItemTypeRequest
			}
			newID := uuid.New()
			sortOrder := it.SortOrder
			if sortOrder == 0 && idx > 0 {
				sortOrder = idx
			}
			result = append(result, clonedItemRow{
				newID:              newID,
				newParentID:        parentID,
				itemType:           itemType,
				name:               validName,
				sortOrder:          sortOrder,
				method:             it.Method,
				url:                it.URL,
				params:             it.Params,
				pathVariables:      it.PathVariables,
				headers:            it.Headers,
				auth:               it.Auth,
				bodyType:           it.BodyType,
				rawType:            it.RawType,
				bodyContent:        it.BodyContent,
				graphqlQuery:       it.GraphQLQuery,
				graphqlVariables:   it.GraphQLVariables,
				bodyFormData:       it.BodyFormData,
				preRequestScript:   it.PreRequestScript,
				postResponseScript: it.PostResponseScript,
			})
			if itemType == domain.ItemTypeFolder && len(it.Items) > 0 {
				pid := newID
				if err := walk(it.Items, &pid, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(items, nil, 1); err != nil {
		return nil, err
	}
	return result, nil
}

func insertClonedItemsInTx(
	ctx context.Context,
	tx pgx.Tx,
	collectionID uuid.UUID,
	rows []clonedItemRow,
	userID uuid.UUID,
	now time.Time,
) error {
	if len(rows) == 0 {
		return nil
	}
	const insertQuery = `
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
			$22, $22
		)
	`
	for _, row := range rows {
		if _, err := tx.Exec(ctx, insertQuery,
			row.newID, collectionID, row.newParentID, string(row.itemType), row.name, row.sortOrder,
			row.method, row.url, row.params, row.pathVariables, row.headers, row.auth, row.bodyType, row.rawType,
			row.bodyContent, row.graphqlQuery, row.graphqlVariables, row.bodyFormData,
			row.preRequestScript, row.postResponseScript, userID, now,
		); err != nil {
			return fmt.Errorf("failed to insert duplicated item %s: %w", row.name, err)
		}
	}
	return nil
}
