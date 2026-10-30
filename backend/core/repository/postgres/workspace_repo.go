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
	ErrWorkspaceNotFound = errors.New("workspace not found")
)

type WorkspaceRepository struct {
	pool *pgxpool.Pool
}

func NewWorkspaceRepository(pool *pgxpool.Pool) *WorkspaceRepository {
	return &WorkspaceRepository{pool: pool}
}

func (r *WorkspaceRepository) Create(ctx context.Context, ws *domain.Workspace) error {
	query := `
		INSERT INTO workspaces (id, owner_id, name, description, is_default, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`
	if ws.ID == uuid.Nil {
		ws.ID = uuid.New()
	}
	now := time.Now().UTC()
	ws.CreatedAt = now
	ws.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, ws.ID, ws.OwnerID, ws.Name, ws.Description, ws.IsDefault, ws.CreatedAt, ws.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert workspace: %w", err)
	}
	return nil
}

func (r *WorkspaceRepository) ListByOwner(ctx context.Context, ownerID uuid.UUID) ([]*domain.Workspace, error) {
	query := `
		SELECT id, owner_id, name, description, is_default, created_at, updated_at
		FROM workspaces
		WHERE owner_id = $1
		ORDER BY is_default DESC, created_at ASC
	`
	rows, err := r.pool.Query(ctx, query, ownerID)
	if err != nil {
		return nil, fmt.Errorf("failed to query workspaces: %w", err)
	}
	defer rows.Close()

	workspaces := make([]*domain.Workspace, 0)
	for rows.Next() {
		var ws domain.Workspace
		if err := rows.Scan(&ws.ID, &ws.OwnerID, &ws.Name, &ws.Description, &ws.IsDefault, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan workspace: %w", err)
		}
		workspaces = append(workspaces, &ws)
	}
	return workspaces, nil
}

func (r *WorkspaceRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Workspace, error) {
	query := `
		SELECT id, owner_id, name, description, is_default, created_at, updated_at
		FROM workspaces
		WHERE id = $1
	`
	var ws domain.Workspace
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&ws.ID,
		&ws.OwnerID,
		&ws.Name,
		&ws.Description,
		&ws.IsDefault,
		&ws.CreatedAt,
		&ws.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkspaceNotFound
		}
		return nil, fmt.Errorf("failed to query workspace by id: %w", err)
	}
	return &ws, nil
}

func (r *WorkspaceRepository) Update(ctx context.Context, ws *domain.Workspace) error {
	query := `
		UPDATE workspaces
		SET name = $1, description = $2, updated_at = $3
		WHERE id = $4 AND owner_id = $5
	`
	ws.UpdatedAt = time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, ws.Name, ws.Description, ws.UpdatedAt, ws.ID, ws.OwnerID)
	if err != nil {
		return fmt.Errorf("failed to update workspace: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrWorkspaceNotFound
	}
	return nil
}

func (r *WorkspaceRepository) Delete(ctx context.Context, id, ownerID uuid.UUID) error {
	query := `DELETE FROM workspaces WHERE id = $1 AND owner_id = $2 AND is_default = FALSE`
	result, err := r.pool.Exec(ctx, query, id, ownerID)
	if err != nil {
		return fmt.Errorf("failed to delete workspace: %w", err)
	}
	if result.RowsAffected() == 0 {
		return errors.New("cannot delete default workspace or workspace not found")
	}
	return nil
}
