package service

import (
	"context"
	"errors"
	"strings"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/adiputera/airrest-backend/internal/repository/postgres"
	"github.com/google/uuid"
)

type WorkspaceService struct {
	workspaceRepo *postgres.WorkspaceRepository
}

func NewWorkspaceService(workspaceRepo *postgres.WorkspaceRepository) *WorkspaceService {
	return &WorkspaceService{workspaceRepo: workspaceRepo}
}

func (s *WorkspaceService) Create(ctx context.Context, user *domain.User, name, description string) (*domain.Workspace, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("workspace name is required")
	}

	var desc *string
	if description != "" {
		desc = &description
	}

	ws := &domain.Workspace{
		ID:          uuid.New(),
		OwnerID:     user.ID,
		Name:        name,
		Description: desc,
		IsDefault:   false,
	}

	if err := s.workspaceRepo.Create(ctx, ws); err != nil {
		return nil, err
	}
	return ws, nil
}

func (s *WorkspaceService) List(ctx context.Context, user *domain.User) ([]*domain.Workspace, error) {
	return s.workspaceRepo.ListByOwner(ctx, user.ID)
}

func (s *WorkspaceService) Get(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.Workspace, error) {
	ws, err := s.workspaceRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Only owner (or superadmin) can view private workspace
	if ws.OwnerID != user.ID && !user.IsSuperadmin() {
		return nil, errors.New("access forbidden")
	}
	return ws, nil
}

func (s *WorkspaceService) Update(ctx context.Context, user *domain.User, id uuid.UUID, name, description string) (*domain.Workspace, error) {
	ws, err := s.Get(ctx, user, id)
	if err != nil {
		return nil, err
	}

	name = strings.TrimSpace(name)
	if name != "" {
		ws.Name = name
	}
	if description != "" {
		ws.Description = &description
	}

	if err := s.workspaceRepo.Update(ctx, ws); err != nil {
		return nil, err
	}
	return ws, nil
}

func (s *WorkspaceService) Delete(ctx context.Context, user *domain.User, id uuid.UUID) error {
	ws, err := s.Get(ctx, user, id)
	if err != nil {
		return err
	}
	if ws.IsDefault {
		return errors.New("cannot delete default private workspace")
	}

	return s.workspaceRepo.Delete(ctx, id, ws.OwnerID)
}
