package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/pkg/hasher"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/google/uuid"
)

var (
	ErrInvalidCredentials       = errors.New("invalid email or password")
	ErrEmailAlreadyExists       = errors.New("a user with this email already exists")
	ErrPasswordTooShort         = errors.New("password must be at least 8 characters long")
	ErrInvalidEmail             = errors.New("invalid email address")
	ErrIncorrectCurrentPassword = errors.New("current password is incorrect")
	ErrNameRequired             = errors.New("name is required")
	ErrCannotDeleteSelf         = errors.New("cannot delete your own account")
	ErrCannotDeleteLastAdmin    = errors.New("cannot delete the last superadmin account")
)

type AuthService struct {
	userRepo     *postgres.UserRepository
	tokenManager *token.TokenManager
}

func NewAuthService(userRepo *postgres.UserRepository, tokenManager *token.TokenManager) *AuthService {
	return &AuthService{
		userRepo:     userRepo,
		tokenManager: tokenManager,
	}
}

type TokenPair struct {
	AccessToken  string    `json:"token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Register registers a new regular user, generates their default private workspace and JWT pair
func (s *AuthService) Register(ctx context.Context, email, password, name string) (*domain.User, *TokenPair, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	name = strings.TrimSpace(name)

	if !strings.Contains(email, "@") || len(email) < 5 {
		return nil, nil, ErrInvalidEmail
	}
	if len(password) < 8 {
		return nil, nil, ErrPasswordTooShort
	}
	if name == "" {
		name = strings.Split(email, "@")[0]
	}

	// Check if user already exists
	existing, err := s.userRepo.GetByEmail(ctx, email)
	if err == nil && existing != nil {
		return nil, nil, ErrEmailAlreadyExists
	}

	// Hash password
	pwdHash, err := hasher.HashPassword(password)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to hash password: %w", err)
	}

	newUser := &domain.User{
		ID:           uuid.New(),
		Email:        email,
		PasswordHash: pwdHash,
		Name:         name,
		Role:         domain.RoleUser,
	}

	if err := s.userRepo.Create(ctx, newUser); err != nil {
		return nil, nil, fmt.Errorf("failed to create user: %w", err)
	}

	// Create default private workspace
	if _, err := s.userRepo.CreateDefaultWorkspace(ctx, newUser.ID, "My Workspace"); err != nil {
		slog.Error("failed to create default workspace for user", "user_id", newUser.ID, "error", err)
	}

	// Issue JWT pair
	jwtToken, expiresAt, err := s.tokenManager.GenerateToken(newUser.ID, newUser.Email, string(newUser.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate access token: %w", err)
	}

	refreshToken, _, err := s.tokenManager.GenerateRefreshToken(newUser.ID, newUser.Email, string(newUser.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	return newUser, &TokenPair{
		AccessToken:  jwtToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

// Login authenticates a user and returns a signed JWT pair
func (s *AuthService) Login(ctx context.Context, email, password string) (*domain.User, *TokenPair, error) {
	email = strings.TrimSpace(strings.ToLower(email))

	user, err := s.userRepo.GetByEmail(ctx, email)
	if err != nil {
		return nil, nil, ErrInvalidCredentials
	}

	if !hasher.CheckPassword(password, user.PasswordHash) {
		return nil, nil, ErrInvalidCredentials
	}

	jwtToken, expiresAt, err := s.tokenManager.GenerateToken(user.ID, user.Email, string(user.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate access token: %w", err)
	}

	refreshToken, _, err := s.tokenManager.GenerateRefreshToken(user.ID, user.Email, string(user.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	return user, &TokenPair{
		AccessToken:  jwtToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

// RefreshToken validates a refresh token and generates a new access token and renewed refresh token
func (s *AuthService) RefreshToken(ctx context.Context, refreshTokenStr string) (*domain.User, *TokenPair, error) {
	claims, err := s.tokenManager.ValidateRefreshToken(refreshTokenStr)
	if err != nil {
		return nil, nil, err
	}

	user, err := s.userRepo.GetByID(ctx, claims.UserID)
	if err != nil || user == nil {
		return nil, nil, errors.New("user not found or deactivated")
	}

	jwtToken, expiresAt, err := s.tokenManager.GenerateToken(user.ID, user.Email, string(user.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate access token: %w", err)
	}

	newRefreshToken, _, err := s.tokenManager.GenerateRefreshToken(user.ID, user.Email, string(user.Role))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	return user, &TokenPair{
		AccessToken:  jwtToken,
		RefreshToken: newRefreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

// BootstrapSuperadmin creates the initial Superadmin if no superadmin exists yet
func (s *AuthService) BootstrapSuperadmin(ctx context.Context, email, password, name string) error {
	count, err := s.userRepo.CountSuperadmins(ctx)
	if err != nil {
		return fmt.Errorf("failed to check superadmin count: %w", err)
	}

	if count > 0 {
		slog.Info("superadmin account already exists, skipping bootstrap")
		return nil
	}

	email = strings.TrimSpace(strings.ToLower(email))
	slog.Info("bootstrapping initial superadmin account", "email", email)

	pwdHash, err := hasher.HashPassword(password)
	if err != nil {
		return fmt.Errorf("failed to hash superadmin password: %w", err)
	}

	superUser := &domain.User{
		ID:           uuid.New(),
		Email:        email,
		PasswordHash: pwdHash,
		Name:         name,
		Role:         domain.RoleSuperadmin,
	}

	if err := s.userRepo.Create(ctx, superUser); err != nil {
		return fmt.Errorf("failed to create superadmin user: %w", err)
	}

	// Create default workspace for superadmin
	if _, err := s.userRepo.CreateDefaultWorkspace(ctx, superUser.ID, "Superadmin Workspace"); err != nil {
		slog.Error("failed to create superadmin default workspace", "error", err)
	}

	slog.Info("superadmin account successfully bootstrapped")
	return nil
}

// CreateUserByAdmin creates a user directly by superadmin with specified role
func (s *AuthService) CreateUserByAdmin(ctx context.Context, email, password, name string, role domain.SystemRole) (*domain.User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	name = strings.TrimSpace(name)

	existing, err := s.userRepo.GetByEmail(ctx, email)
	if err == nil && existing != nil {
		return nil, ErrEmailAlreadyExists
	}

	if len(password) < 8 {
		return nil, ErrPasswordTooShort
	}

	pwdHash, err := hasher.HashPassword(password)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	newUser := &domain.User{
		ID:           uuid.New(),
		Email:        email,
		PasswordHash: pwdHash,
		Name:         name,
		Role:         role,
	}

	if err := s.userRepo.Create(ctx, newUser); err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	if _, err := s.userRepo.CreateDefaultWorkspace(ctx, newUser.ID, "Default Workspace"); err != nil {
		slog.Error("failed to create default workspace for user", "user_id", newUser.ID, "error", err)
	}

	return newUser, nil
}

// ListUsers returns all users in the system (for superadmin)
func (s *AuthService) ListUsers(ctx context.Context) ([]*domain.User, error) {
	return s.userRepo.ListAll(ctx)
}

// GetUserByID returns user by ID
func (s *AuthService) GetUserByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
	return s.userRepo.GetByID(ctx, id)
}

// UpdateProfile updates the display name and avatar URL of a user
func (s *AuthService) UpdateProfile(ctx context.Context, userID uuid.UUID, name string, avatarURL *string) (*domain.User, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, ErrNameRequired
	}
	return s.userRepo.UpdateProfile(ctx, userID, name, avatarURL)
}

// ChangePassword verifies the current password and hashes/stores the new password
func (s *AuthService) ChangePassword(ctx context.Context, userID uuid.UUID, currentPassword, newPassword string) error {
	if len(newPassword) < 8 {
		return ErrPasswordTooShort
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if !hasher.CheckPassword(currentPassword, user.PasswordHash) {
		return ErrIncorrectCurrentPassword
	}

	newHash, err := hasher.HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	return s.userRepo.UpdatePassword(ctx, userID, newHash)
}

// ResetPasswordByAdmin allows superadmin to reset any user's password without requiring current password
func (s *AuthService) ResetPasswordByAdmin(ctx context.Context, userID uuid.UUID, newPassword string) error {
	if len(newPassword) < 8 {
		return ErrPasswordTooShort
	}

	if _, err := s.userRepo.GetByID(ctx, userID); err != nil {
		return err
	}

	newHash, err := hasher.HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	return s.userRepo.UpdatePassword(ctx, userID, newHash)
}

// SearchUsers searches users by email or name (minimum 2 characters query)
func (s *AuthService) SearchUsers(ctx context.Context, query string) ([]*domain.User, error) {
	query = strings.TrimSpace(query)
	if len(query) < 2 {
		return []*domain.User{}, nil
	}
	return s.userRepo.SearchUsers(ctx, query, 20)
}

// DeleteUserByAdmin removes a user from the platform, reassigning their created entities to the superadmin
func (s *AuthService) DeleteUserByAdmin(ctx context.Context, adminID, targetUserID uuid.UUID) error {
	if adminID == targetUserID {
		return ErrCannotDeleteSelf
	}

	targetUser, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return err
	}

	if targetUser.IsSuperadmin() {
		count, err := s.userRepo.CountSuperadmins(ctx)
		if err != nil {
			return fmt.Errorf("failed to count superadmins: %w", err)
		}
		if count <= 1 {
			return ErrCannotDeleteLastAdmin
		}
	}

	return s.userRepo.Delete(ctx, targetUserID, adminID)
}

