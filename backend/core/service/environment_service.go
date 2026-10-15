package service

import (
	"context"
	"errors"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

type EnvironmentService struct {
	envRepo           *postgres.EnvironmentRepository
	collectionService *CollectionService
}

func NewEnvironmentService(
	envRepo *postgres.EnvironmentRepository,
	collectionService *CollectionService,
) *EnvironmentService {
	return &EnvironmentService{
		envRepo:           envRepo,
		collectionService: collectionService,
	}
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

	env.LastModifiedBy = &user.ID
	return s.envRepo.Create(ctx, env)
}

// List lists all active environments for a workspace or project
func (s *EnvironmentService) List(ctx context.Context, user *domain.User, workspaceID, projectID *uuid.UUID) ([]*domain.Environment, error) {
	if err := s.collectionService.CheckPermission(ctx, user, workspaceID, projectID, false); err != nil {
		return nil, err
	}

	return s.envRepo.List(ctx, workspaceID, projectID)
}

// Get gets an environment by ID
func (s *EnvironmentService) Get(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.Environment, error) {
	env, err := s.envRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if err := s.collectionService.CheckPermission(ctx, user, env.WorkspaceID, env.ProjectID, false); err != nil {
		return nil, err
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

	env.LastModifiedBy = &user.ID
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

	if err := s.collectionService.CheckPermission(ctx, user, existing.WorkspaceID, existing.ProjectID, true); err != nil {
		return err
	}

	return s.envRepo.SoftDelete(ctx, id, user.ID)
}
