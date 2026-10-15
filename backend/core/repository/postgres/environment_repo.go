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
	ErrEnvironmentNotFound = errors.New("environment not found")
)

type EnvironmentRepository struct {
	pool *pgxpool.Pool
}

func NewEnvironmentRepository(pool *pgxpool.Pool) *EnvironmentRepository {
	return &EnvironmentRepository{pool: pool}
}

func (r *EnvironmentRepository) Create(ctx context.Context, env *domain.Environment) error {
	query := `
		INSERT INTO environments (id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
	`
	if env.ID == uuid.Nil {
		env.ID = uuid.New()
	}
	now := time.Now().UTC()
	env.Version = 1
	env.CreatedAt = now
	env.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, env.ID, env.WorkspaceID, env.ProjectID, env.Name, env.Variables, env.LastModifiedBy, env.CreatedAt, env.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create environment: %w", err)
	}
	return nil
}

func (r *EnvironmentRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Environment, error) {
	query := `
		SELECT id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at, deleted_at
		FROM environments
		WHERE id = $1
	`
	var env domain.Environment
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables,
		&env.Version, &env.LastModifiedBy, &env.CreatedAt, &env.UpdatedAt, &env.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrEnvironmentNotFound
		}
		return nil, fmt.Errorf("failed to get environment: %w", err)
	}
	return &env, nil
}

func (r *EnvironmentRepository) List(ctx context.Context, workspaceID, projectID *uuid.UUID) ([]*domain.Environment, error) {
	var query string
	var rows pgx.Rows
	var err error

	if workspaceID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE workspace_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *workspaceID)
	} else if projectID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, variables, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE project_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *projectID)
	} else {
		return nil, errors.New("must specify workspace_id or project_id")
	}

	if err != nil {
		return nil, fmt.Errorf("failed to list environments: %w", err)
	}
	defer rows.Close()

	var envs []*domain.Environment
	for rows.Next() {
		var env domain.Environment
		if err := rows.Scan(
			&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables,
			&env.Version, &env.LastModifiedBy, &env.CreatedAt, &env.UpdatedAt, &env.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan environment: %w", err)
		}
		envs = append(envs, &env)
	}
	return envs, nil
}

func (r *EnvironmentRepository) Update(ctx context.Context, env *domain.Environment, baseVersion int64) error {
	query := `
		UPDATE environments
		SET name = $1, variables = $2, version = version + 1, last_modified_by = $3, updated_at = $4
		WHERE id = $5 AND version = $6 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, env.Name, env.Variables, env.LastModifiedBy, now, env.ID, baseVersion)
	if err != nil {
		return fmt.Errorf("failed to update environment: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrVersionConflict
	}
	env.Version = baseVersion + 1
	env.UpdatedAt = now
	return nil
}

func (r *EnvironmentRepository) SoftDelete(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	query := `
		UPDATE environments
		SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
		WHERE id = $3 AND deleted_at IS NULL
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, now, modifiedBy, id)
	if err != nil {
		return fmt.Errorf("failed to soft delete environment: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrEnvironmentNotFound
	}
	return nil
}
