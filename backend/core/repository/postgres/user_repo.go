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
	ErrUserNotFound      = errors.New("user not found")
	ErrUserAlreadyExists = errors.New("user with this email already exists")
)

type UserRepository struct {
	pool *pgxpool.Pool
}

func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{pool: pool}
}

// Create inserts a new user
func (r *UserRepository) Create(ctx context.Context, u *domain.User) error {
	query := `
		INSERT INTO users (id, email, password_hash, name, avatar_url, role, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	now := time.Now().UTC()
	u.CreatedAt = now
	u.UpdatedAt = now

	_, err := r.pool.Exec(ctx, query, u.ID, u.Email, u.PasswordHash, u.Name, u.AvatarURL, string(u.Role), u.CreatedAt, u.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert user: %w", err)
	}

	return nil
}

// GetByEmail retrieves a user by email
func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, avatar_url, role, created_at, updated_at
		FROM users
		WHERE email = $1
	`
	var u domain.User
	var roleStr string
	err := r.pool.QueryRow(ctx, query, email).Scan(
		&u.ID,
		&u.Email,
		&u.PasswordHash,
		&u.Name,
		&u.AvatarURL,
		&roleStr,
		&u.CreatedAt,
		&u.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to query user by email: %w", err)
	}
	u.Role = domain.SystemRole(roleStr)
	return &u, nil
}

// GetByID retrieves a user by UUID
func (r *UserRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, avatar_url, role, created_at, updated_at
		FROM users
		WHERE id = $1
	`
	var u domain.User
	var roleStr string
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&u.ID,
		&u.Email,
		&u.PasswordHash,
		&u.Name,
		&u.AvatarURL,
		&roleStr,
		&u.CreatedAt,
		&u.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to query user by id: %w", err)
	}
	u.Role = domain.SystemRole(roleStr)
	return &u, nil
}

// CountSuperadmins returns the number of superadmin users in the system
func (r *UserRepository) CountSuperadmins(ctx context.Context) (int, error) {
	query := `SELECT COUNT(*) FROM users WHERE role = 'superadmin'`
	var count int
	err := r.pool.QueryRow(ctx, query).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count superadmins: %w", err)
	}
	return count, nil
}

// ListAll returns all users (ordered by creation date)
func (r *UserRepository) ListAll(ctx context.Context) ([]*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, avatar_url, role, created_at, updated_at
		FROM users
		ORDER BY created_at DESC
	`
	rows, err := r.pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query users: %w", err)
	}
	defer rows.Close()

	var users []*domain.User
	for rows.Next() {
		var u domain.User
		var roleStr string
		err := rows.Scan(
			&u.ID,
			&u.Email,
			&u.PasswordHash,
			&u.Name,
			&u.AvatarURL,
			&roleStr,
			&u.CreatedAt,
			&u.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		u.Role = domain.SystemRole(roleStr)
		users = append(users, &u)
	}

	return users, nil
}

// CreateDefaultWorkspace creates the first private workspace for a user
func (r *UserRepository) CreateDefaultWorkspace(ctx context.Context, userID uuid.UUID, name string) (*domain.Workspace, error) {
	query := `
		INSERT INTO workspaces (id, owner_id, name, is_default, created_at, updated_at)
		VALUES ($1, $2, $3, TRUE, $4, $5)
		RETURNING id, owner_id, name, description, is_default, created_at, updated_at
	`
	now := time.Now().UTC()
	wsID := uuid.New()
	var ws domain.Workspace
	err := r.pool.QueryRow(ctx, query, wsID, userID, name, now, now).Scan(
		&ws.ID,
		&ws.OwnerID,
		&ws.Name,
		&ws.Description,
		&ws.IsDefault,
		&ws.CreatedAt,
		&ws.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create default workspace: %w", err)
	}
	return &ws, nil
}

// UpdateProfile updates the display name and avatar URL of a user
func (r *UserRepository) UpdateProfile(ctx context.Context, id uuid.UUID, name string, avatarURL *string) (*domain.User, error) {
	query := `
		UPDATE users
		SET name = $1, avatar_url = $2, updated_at = $3
		WHERE id = $4
		RETURNING id, email, password_hash, name, avatar_url, role, created_at, updated_at
	`
	now := time.Now().UTC()
	var u domain.User
	var roleStr string
	err := r.pool.QueryRow(ctx, query, name, avatarURL, now, id).Scan(
		&u.ID,
		&u.Email,
		&u.PasswordHash,
		&u.Name,
		&u.AvatarURL,
		&roleStr,
		&u.CreatedAt,
		&u.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update user profile: %w", err)
	}
	u.Role = domain.SystemRole(roleStr)
	return &u, nil
}

// UpdatePassword updates the hashed password of a user
func (r *UserRepository) UpdatePassword(ctx context.Context, id uuid.UUID, newPasswordHash string) error {
	query := `
		UPDATE users
		SET password_hash = $1, updated_at = $2
		WHERE id = $3
	`
	now := time.Now().UTC()
	result, err := r.pool.Exec(ctx, query, newPasswordHash, now, id)
	if err != nil {
		return fmt.Errorf("failed to update user password: %w", err)
	}
	if result.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	return nil
}

// SearchUsers searches users by email or name (limit bounded to max 50)
func (r *UserRepository) SearchUsers(ctx context.Context, queryStr string, limit int) ([]*domain.User, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	query := `
		SELECT id, email, password_hash, name, avatar_url, role, created_at, updated_at
		FROM users
		WHERE email ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
		ORDER BY name ASC, email ASC
		LIMIT $2
	`
	rows, err := r.pool.Query(ctx, query, queryStr, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to search users: %w", err)
	}
	defer rows.Close()

	var users []*domain.User
	for rows.Next() {
		var u domain.User
		var roleStr string
		err := rows.Scan(
			&u.ID,
			&u.Email,
			&u.PasswordHash,
			&u.Name,
			&u.AvatarURL,
			&roleStr,
			&u.CreatedAt,
			&u.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		u.Role = domain.SystemRole(roleStr)
		users = append(users, &u)
	}
	return users, nil
}
