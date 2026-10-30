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
	ErrTeamNotFound       = errors.New("team not found")
	ErrTeamMemberNotFound = errors.New("team member not found")
)

type TeamRepository struct {
	pool *pgxpool.Pool
}

func NewTeamRepository(pool *pgxpool.Pool) *TeamRepository {
	return &TeamRepository{pool: pool}
}

func (r *TeamRepository) Create(ctx context.Context, t *domain.Team) error {
	query := `
		INSERT INTO teams (id, name, description, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	now := time.Now().UTC()
	t.CreatedAt = now
	t.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, t.ID, t.Name, t.Description, t.CreatedBy, t.CreatedAt, t.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create team: %w", err)
	}
	return nil
}

func (r *TeamRepository) ListForUser(ctx context.Context, userID uuid.UUID, isSuperadmin bool) ([]*domain.Team, error) {
	var query string
	var rows pgx.Rows
	var err error

	if isSuperadmin {
		query = `
			SELECT t.id, t.name, t.description, t.created_by, t.created_at, t.updated_at, COALESCE(tm.role, 'admin')
			FROM teams t
			LEFT JOIN team_members tm ON t.id = tm.team_id AND tm.user_id = $1
			ORDER BY t.name ASC
		`
		rows, err = r.pool.Query(ctx, query, userID)
	} else {
		query = `
			SELECT t.id, t.name, t.description, t.created_by, t.created_at, t.updated_at, tm.role
			FROM teams t
			JOIN team_members tm ON t.id = tm.team_id
			WHERE tm.user_id = $1
			ORDER BY t.name ASC
		`
		rows, err = r.pool.Query(ctx, query, userID)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to list teams: %w", err)
	}
	defer rows.Close()

	teams := make([]*domain.Team, 0)
	for rows.Next() {
		var t domain.Team
		var roleStr string
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &roleStr); err != nil {
			return nil, fmt.Errorf("failed to scan team: %w", err)
		}
		role := domain.TeamRole(roleStr)
		t.UserRole = &role
		teams = append(teams, &t)
	}
	return teams, nil
}

func (r *TeamRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Team, error) {
	query := `SELECT id, name, description, created_by, created_at, updated_at FROM teams WHERE id = $1`
	var t domain.Team
	err := r.pool.QueryRow(ctx, query, id).Scan(&t.ID, &t.Name, &t.Description, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTeamNotFound
		}
		return nil, fmt.Errorf("failed to get team: %w", err)
	}
	return &t, nil
}

func (r *TeamRepository) Update(ctx context.Context, t *domain.Team) error {
	query := `UPDATE teams SET name = $1, description = $2, updated_at = $3 WHERE id = $4`
	t.UpdatedAt = time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, t.Name, t.Description, t.UpdatedAt, t.ID)
	if err != nil {
		return fmt.Errorf("failed to update team: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrTeamNotFound
	}
	return nil
}

func (r *TeamRepository) Delete(ctx context.Context, id uuid.UUID) error {
	query := `DELETE FROM teams WHERE id = $1`
	result, err := r.pool.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete team: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrTeamNotFound
	}
	return nil
}

func (r *TeamRepository) AddMember(ctx context.Context, m *domain.TeamMember) error {
	query := `
		INSERT INTO team_members (id, team_id, user_id, role, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at
	`
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	now := time.Now().UTC()
	m.CreatedAt = now
	m.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, m.ID, m.TeamID, m.UserID, string(m.Role), m.CreatedAt, m.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to add team member: %w", err)
	}
	return nil
}

func (r *TeamRepository) UpdateMemberRole(ctx context.Context, teamID, userID uuid.UUID, role domain.TeamRole) error {
	query := `UPDATE team_members SET role = $1, updated_at = $2 WHERE team_id = $3 AND user_id = $4`
	result, err := r.pool.Exec(ctx, query, string(role), time.Now().UTC(), teamID, userID)
	if err != nil {
		return fmt.Errorf("failed to update member role: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrTeamMemberNotFound
	}
	return nil
}

func (r *TeamRepository) RemoveMember(ctx context.Context, teamID, userID uuid.UUID) error {
	// Clean up any project assignments under this team for the user
	cleanupProjectsQuery := `
		DELETE FROM project_members
		WHERE project_id IN (SELECT id FROM projects WHERE team_id = $1)
		  AND user_id = $2
	`
	_, _ = r.pool.Exec(ctx, cleanupProjectsQuery, teamID, userID)

	query := `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`
	result, err := r.pool.Exec(ctx, query, teamID, userID)
	if err != nil {
		return fmt.Errorf("failed to remove team member: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrTeamMemberNotFound
	}
	return nil
}

func (r *TeamRepository) GetMember(ctx context.Context, teamID, userID uuid.UUID) (*domain.TeamMember, error) {
	query := `
		SELECT id, team_id, user_id, role, created_at, updated_at
		FROM team_members
		WHERE team_id = $1 AND user_id = $2
	`
	var m domain.TeamMember
	var roleStr string
	err := r.pool.QueryRow(ctx, query, teamID, userID).Scan(&m.ID, &m.TeamID, &m.UserID, &roleStr, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTeamMemberNotFound
		}
		return nil, fmt.Errorf("failed to get team member: %w", err)
	}
	m.Role = domain.TeamRole(roleStr)
	return &m, nil
}

func (r *TeamRepository) ListMembers(ctx context.Context, teamID uuid.UUID) ([]*domain.TeamMember, error) {
	query := `
		SELECT tm.id, tm.team_id, tm.user_id, tm.role, tm.created_at, tm.updated_at,
		       u.id, u.email, u.name, u.avatar_url, u.role
		FROM team_members tm
		JOIN users u ON tm.user_id = u.id
		WHERE tm.team_id = $1
		ORDER BY tm.created_at ASC
	`
	rows, err := r.pool.Query(ctx, query, teamID)
	if err != nil {
		return nil, fmt.Errorf("failed to list team members: %w", err)
	}
	defer rows.Close()

	members := make([]*domain.TeamMember, 0)
	for rows.Next() {
		var m domain.TeamMember
		var roleStr, userRoleStr string
		var u domain.User
		err := rows.Scan(
			&m.ID, &m.TeamID, &m.UserID, &roleStr, &m.CreatedAt, &m.UpdatedAt,
			&u.ID, &u.Email, &u.Name, &u.AvatarURL, &userRoleStr,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan team member: %w", err)
		}
		m.Role = domain.TeamRole(roleStr)
		u.Role = domain.SystemRole(userRoleStr)
		m.User = &u
		members = append(members, &m)
	}
	return members, nil
}
