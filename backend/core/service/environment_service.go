package service

import (
	"context"
	"errors"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

var (
	ErrEnvAccessDenied     = errors.New("insufficient project role to access this environment")
	ErrAdminRequiredForEnv = errors.New("admin role required to configure admin-restricted environment")
)

type EnvironmentService struct {
	envRepo           *postgres.EnvironmentRepository
	collectionService *CollectionService
	projectService    *ProjectService
}

func NewEnvironmentService(
	envRepo *postgres.EnvironmentRepository,
	collectionService *CollectionService,
	projectService *ProjectService,
) *EnvironmentService {
	return &EnvironmentService{
		envRepo:           envRepo,
		collectionService: collectionService,
		projectService:    projectService,
	}
}

// CanAccessEnv checks whether a user with a given project role meets the required min_role
func CanAccessEnv(userRole domain.ProjectRole, minRole domain.ProjectRole) bool {
	roleRank := map[domain.ProjectRole]int{
		domain.ProjectRoleAdmin:       4,
		domain.ProjectRoleMaintainer:  3,
		domain.ProjectRoleContributor: 2,
		domain.ProjectRoleReader:      1,
	}
	userRank := roleRank[userRole]
	minRank := roleRank[minRole]
	if minRank == 0 {
		minRank = 1 // default reader
	}
	return userRank >= minRank
}

// Create creates a new environment in a workspace or project
func (s *EnvironmentService) Create(ctx context.Context, user *domain.User, env *domain.Environment) error {
	if err := s.collectionService.CheckPermission(ctx, user, env.WorkspaceID, env.ProjectID, true); err != nil {
		return err
	}

	env.Name = strings.TrimSpace(env.Name)
	if env.Name == "" {
		return errors.New("environment name is required")
	}

	if env.MinRole == "" {
		env.MinRole = domain.ProjectRoleReader
	}

	// Validate min_role value
	switch env.MinRole {
	case domain.ProjectRoleAdmin, domain.ProjectRoleMaintainer, domain.ProjectRoleContributor, domain.ProjectRoleReader:
	default:
		return errors.New("invalid min_role, must be admin, maintainer, contributor, or reader")
	}

	if env.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *env.ProjectID)
		if err != nil {
			return ErrForbidden
		}
		// Caller cannot create an environment with a min_role higher than their own role
		if !CanAccessEnv(role, env.MinRole) {
			return ErrEnvAccessDenied
		}
	}

	env.LastModifiedBy = &user.ID
	return s.envRepo.Create(ctx, env)
}

// List lists all active environments for a workspace or project that the user has permission to see
func (s *EnvironmentService) List(ctx context.Context, user *domain.User, workspaceID, projectID *uuid.UUID) ([]*domain.Environment, error) {
	if err := s.collectionService.CheckPermission(ctx, user, workspaceID, projectID, false); err != nil {
		return nil, err
	}

	envs, err := s.envRepo.List(ctx, workspaceID, projectID)
	if err != nil {
		return nil, err
	}

	// If project scoped and user is not superadmin, filter environments based on user's effective role
	if projectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *projectID)
		if err != nil {
			return nil, ErrForbidden
		}

		filtered := make([]*domain.Environment, 0, len(envs))
		for _, env := range envs {
			if CanAccessEnv(role, env.MinRole) {
				filtered = append(filtered, env)
			}
		}
		return filtered, nil
	}

	return envs, nil
}

// Get gets an environment by ID if the user has permission to view it
func (s *EnvironmentService) Get(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.Environment, error) {
	env, err := s.envRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if err := s.collectionService.CheckPermission(ctx, user, env.WorkspaceID, env.ProjectID, false); err != nil {
		return nil, err
	}

	if env.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *env.ProjectID)
		if err != nil {
			return nil, ErrForbidden
		}
		if !CanAccessEnv(role, env.MinRole) {
			return nil, ErrEnvAccessDenied
		}
	}

	return env, nil
}

// Update updates an environment with OCC base_version validation
func (s *EnvironmentService) Update(ctx context.Context, user *domain.User, env *domain.Environment, baseVersion int64) (*domain.Environment, error) {
	existing, err := s.envRepo.GetByID(ctx, env.ID)
	if err != nil {
		return nil, err
	}

	if err := s.collectionService.CheckPermission(ctx, user, existing.WorkspaceID, existing.ProjectID, true); err != nil {
		return nil, err
	}

	if existing.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *existing.ProjectID)
		if err != nil {
			return nil, ErrForbidden
		}
		// Caller must be able to access existing environment
		if !CanAccessEnv(role, existing.MinRole) {
			return nil, ErrEnvAccessDenied
		}

		// Caller cannot set or escalate min_role higher than their own role
		if env.MinRole != "" && !CanAccessEnv(role, env.MinRole) {
			return nil, ErrEnvAccessDenied
		}
	}

	if env.Name == "" {
		env.Name = existing.Name
	}
	if env.Variables == nil {
		env.Variables = existing.Variables
	}
	if env.MinRole == "" {
		env.MinRole = existing.MinRole
	}

	env.LastModifiedBy = &user.ID
	if baseVersion <= 0 {
		baseVersion = existing.Version
	}
	err = s.envRepo.Update(ctx, env, baseVersion)
	if err != nil {
		if errors.Is(err, postgres.ErrVersionConflict) {
			latest, _ := s.envRepo.GetByID(ctx, env.ID)
			return latest, err
		}
		return nil, err
	}

	return env, nil
}

// Delete soft deletes an environment (tombstone)
func (s *EnvironmentService) Delete(ctx context.Context, user *domain.User, id uuid.UUID) error {
	existing, err := s.envRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	if err := s.collectionService.CheckOperationPermission(ctx, user, existing.WorkspaceID, existing.ProjectID, domain.PermissionEnvDelete); err != nil {
		return err
	}

	if existing.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *existing.ProjectID)
		if err != nil {
			return ErrForbidden
		}
		if !CanAccessEnv(role, existing.MinRole) {
			return ErrEnvAccessDenied
		}
	}

	return s.envRepo.SoftDelete(ctx, id, user.ID)
}
