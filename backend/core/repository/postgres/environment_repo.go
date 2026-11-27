package postgres

import (
	"context"
	"errors"
	"fmt"

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
		INSERT INTO environments (id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 1, $7, clock_timestamp(), clock_timestamp())
		RETURNING created_at, updated_at
	`
	if env.ID == uuid.Nil {
		env.ID = uuid.New()
	}
	if env.MinRole == "" {
		env.MinRole = domain.ProjectRoleReader
	}
	env.Version = 1

	err := r.pool.QueryRow(ctx, query, env.ID, env.WorkspaceID, env.ProjectID, env.Name, env.Variables, env.MinRole, env.LastModifiedBy).Scan(&env.CreatedAt, &env.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create environment: %w", err)
	}
	env.CreatedAt = env.CreatedAt.UTC()
	env.UpdatedAt = env.UpdatedAt.UTC()
	return nil
}

func (r *EnvironmentRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Environment, error) {
	query := `
		SELECT id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at, deleted_at
		FROM environments
		WHERE id = $1
	`
	var env domain.Environment
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables, &env.MinRole,
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
			SELECT id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at, deleted_at
			FROM environments
			WHERE workspace_id = $1 AND deleted_at IS NULL
			ORDER BY created_at ASC
		`
		rows, err = r.pool.Query(ctx, query, *workspaceID)
	} else if projectID != nil {
		query = `
			SELECT id, workspace_id, project_id, name, variables, min_role, version, last_modified_by, created_at, updated_at, deleted_at
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

	envs := make([]*domain.Environment, 0)
	for rows.Next() {
		var env domain.Environment
		if err := rows.Scan(
			&env.ID, &env.WorkspaceID, &env.ProjectID, &env.Name, &env.Variables, &env.MinRole,
			&env.Version, &env.LastModifiedBy, &env.CreatedAt, &env.UpdatedAt, &env.DeletedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan environment: %w", err)
		}
		envs = append(envs, &env)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate environments: %w", err)
	}
	return envs, nil
}

func (r *EnvironmentRepository) Update(ctx context.Context, env *domain.Environment, baseVersion int64) error {
	query := `
		UPDATE environments
		SET name = $1, variables = $2, min_role = $3, version = version + 1, last_modified_by = $4, updated_at = clock_timestamp()
		WHERE id = $5 AND version = $6 AND deleted_at IS NULL
		RETURNING updated_at
	`
	if env.MinRole == "" {
		env.MinRole = domain.ProjectRoleReader
	}
	err := r.pool.QueryRow(ctx, query, env.Name, env.Variables, env.MinRole, env.LastModifiedBy, env.ID, baseVersion).Scan(&env.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrVersionConflict
		}
		return fmt.Errorf("failed to update environment: %w", err)
	}
	env.Version = baseVersion + 1
	env.UpdatedAt = env.UpdatedAt.UTC()
	return nil
}

func (r *EnvironmentRepository) SoftDelete(ctx context.Context, id uuid.UUID, modifiedBy uuid.UUID) error {
	query := `
		UPDATE environments
		SET deleted_at = clock_timestamp(), updated_at = clock_timestamp(), last_modified_by = $1, version = version + 1
		WHERE id = $2 AND deleted_at IS NULL
	`
	result, err := r.pool.Exec(ctx, query, modifiedBy, id)
	if err != nil {
		return fmt.Errorf("failed to soft delete environment: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrEnvironmentNotFound
	}
	return nil
}
