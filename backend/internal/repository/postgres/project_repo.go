package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrProjectNotFound       = errors.New("project not found")
	ErrProjectMemberNotFound = errors.New("project member not found")
)

type ProjectRepository struct {
	pool *pgxpool.Pool
}

func NewProjectRepository(pool *pgxpool.Pool) *ProjectRepository {
	return &ProjectRepository{pool: pool}
}

func (r *ProjectRepository) Create(ctx context.Context, p *domain.Project) error {
	query := `
		INSERT INTO projects (id, team_id, name, description, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	now := time.Now().UTC()
	p.CreatedAt = now
	p.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, p.ID, p.TeamID, p.Name, p.Description, p.CreatedBy, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create project: %w", err)
	}
	return nil
}

// ListForUser returns projects in a team with strict visibility isolation:
// Superadmins and Team Admins see all projects.
// Regular members see ONLY projects where they are in project_members.
func (r *ProjectRepository) ListForUser(ctx context.Context, teamID, userID uuid.UUID, isSuperadmin, isTeamAdmin bool) ([]*domain.Project, error) {
	var query string
	var rows pgx.Rows
	var err error

	if isSuperadmin || isTeamAdmin {
		query = `
			SELECT id, team_id, name, description, created_by, created_at, updated_at
			FROM projects
			WHERE team_id = $1
			ORDER BY name ASC
		`
		rows, err = r.pool.Query(ctx, query, teamID)
	} else {
		query = `
			SELECT p.id, p.team_id, p.name, p.description, p.created_by, p.created_at, p.updated_at
			FROM projects p
			JOIN project_members pm ON p.id = pm.project_id
			WHERE p.team_id = $1 AND pm.user_id = $2
			ORDER BY p.name ASC
		`
		rows, err = r.pool.Query(ctx, query, teamID, userID)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to list projects: %w", err)
	}
	defer rows.Close()

	var projects []*domain.Project
	for rows.Next() {
		var p domain.Project
		if err := rows.Scan(&p.ID, &p.TeamID, &p.Name, &p.Description, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan project: %w", err)
		}
		projects = append(projects, &p)
	}
	return projects, nil
}

func (r *ProjectRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Project, error) {
	query := `SELECT id, team_id, name, description, created_by, created_at, updated_at FROM projects WHERE id = $1`
	var p domain.Project
	err := r.pool.QueryRow(ctx, query, id).Scan(&p.ID, &p.TeamID, &p.Name, &p.Description, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrProjectNotFound
		}
		return nil, fmt.Errorf("failed to get project: %w", err)
	}
	return &p, nil
}

func (r *ProjectRepository) Update(ctx context.Context, p *domain.Project) error {
	query := `UPDATE projects SET name = $1, description = $2, updated_at = $3 WHERE id = $4`
	p.UpdatedAt = time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, p.Name, p.Description, p.UpdatedAt, p.ID)
	if err != nil {
		return fmt.Errorf("failed to update project: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrProjectNotFound
	}
	return nil
}

func (r *ProjectRepository) Delete(ctx context.Context, id uuid.UUID) error {
	query := `DELETE FROM projects WHERE id = $1`
	result, err := r.pool.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete project: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrProjectNotFound
	}
	return nil
}

func (r *ProjectRepository) AddMember(ctx context.Context, m *domain.ProjectMember) error {
	query := `
		INSERT INTO project_members (id, project_id, user_id, role, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at
	`
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	now := time.Now().UTC()
	m.CreatedAt = now
	m.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, m.ID, m.ProjectID, m.UserID, string(m.Role), m.CreatedAt, m.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to add project member: %w", err)
	}
	return nil
}

func (r *ProjectRepository) UpdateMemberRole(ctx context.Context, projectID, userID uuid.UUID, role domain.ProjectRole) error {
	query := `UPDATE project_members SET role = $1, updated_at = $2 WHERE project_id = $3 AND user_id = $4`
	result, err := r.pool.Exec(ctx, query, string(role), time.Now().UTC(), projectID, userID)
	if err != nil {
		return fmt.Errorf("failed to update project member role: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrProjectMemberNotFound
	}
	return nil
}

func (r *ProjectRepository) RemoveMember(ctx context.Context, projectID, userID uuid.UUID) error {
	query := `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`
	result, err := r.pool.Exec(ctx, query, projectID, userID)
	if err != nil {
		return fmt.Errorf("failed to remove project member: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrProjectMemberNotFound
	}
	return nil
}

func (r *ProjectRepository) GetMember(ctx context.Context, projectID, userID uuid.UUID) (*domain.ProjectMember, error) {
	query := `
		SELECT id, project_id, user_id, role, created_at, updated_at
		FROM project_members
		WHERE project_id = $1 AND user_id = $2
	`
	var m domain.ProjectMember
	var roleStr string
	err := r.pool.QueryRow(ctx, query, projectID, userID).Scan(&m.ID, &m.ProjectID, &m.UserID, &roleStr, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrProjectMemberNotFound
		}
		return nil, fmt.Errorf("failed to get project member: %w", err)
	}
	m.Role = domain.ProjectRole(roleStr)
	return &m, nil
}

func (r *ProjectRepository) ListMembers(ctx context.Context, projectID uuid.UUID) ([]*domain.ProjectMember, error) {
	query := `
		SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.created_at, pm.updated_at,
		       u.id, u.email, u.name, u.avatar_url, u.role
		FROM project_members pm
		JOIN users u ON pm.user_id = u.id
		WHERE pm.project_id = $1
		ORDER BY pm.created_at ASC
	`
	rows, err := r.pool.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list project members: %w", err)
	}
	defer rows.Close()

	var members []*domain.ProjectMember
	for rows.Next() {
		var m domain.ProjectMember
		var roleStr, userRoleStr string
		var u domain.User
		err := rows.Scan(
			&m.ID, &m.ProjectID, &m.UserID, &roleStr, &m.CreatedAt, &m.UpdatedAt,
			&u.ID, &u.Email, &u.Name, &u.AvatarURL, &userRoleStr,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan project member: %w", err)
		}
		m.Role = domain.ProjectRole(roleStr)
		u.Role = domain.SystemRole(userRoleStr)
		m.User = &u
		members = append(members, &m)
	}
	return members, nil
}
