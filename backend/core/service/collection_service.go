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
	ErrReaderCannotModify = errors.New("reader role does not have permission to create or modify collections/requests")
)

type CollectionService struct {
	collectionRepo *postgres.CollectionRepository
	workspaceRepo  *postgres.WorkspaceRepository
	projectService *ProjectService
}

func NewCollectionService(
	collectionRepo *postgres.CollectionRepository,
	workspaceRepo *postgres.WorkspaceRepository,
	projectService *ProjectService,
) *CollectionService {
	return &CollectionService{
		collectionRepo: collectionRepo,
		workspaceRepo:  workspaceRepo,
		projectService: projectService,
	}
}

// CheckPermission checks if user can read or write in the scope
func (s *CollectionService) CheckPermission(ctx context.Context, user *domain.User, workspaceID, projectID *uuid.UUID, requireWrite bool) error {
	if user.IsSuperadmin() {
		return nil
	}

	if workspaceID != nil {
		ws, err := s.workspaceRepo.GetByID(ctx, *workspaceID)
		if err != nil {
			return err
		}
		if ws.OwnerID != user.ID {
			return ErrForbidden
		}
		return nil
	}

	if projectID != nil {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *projectID)
		if err != nil {
			return ErrForbidden
		}
		if requireWrite && role == domain.ProjectRoleReader {
			return ErrReaderCannotModify
		}
		return nil
	}

	return errors.New("must specify either workspace_id or project_id")
}

// CreateCollection creates a collection in workspace or project
func (s *CollectionService) CreateCollection(ctx context.Context, user *domain.User, c *domain.Collection) error {
	if err := s.CheckPermission(ctx, user, c.WorkspaceID, c.ProjectID, true); err != nil {
		return err
	}

	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" {
		return errors.New("collection name is required")
	}

	c.CreatedBy = user.ID
	c.LastModifiedBy = &user.ID
	return s.collectionRepo.CreateCollection(ctx, c)
}

// ListCollections lists collections in workspace or project
func (s *CollectionService) ListCollections(ctx context.Context, user *domain.User, workspaceID, projectID *uuid.UUID) ([]*domain.Collection, error) {
	if err := s.CheckPermission(ctx, user, workspaceID, projectID, false); err != nil {
		return nil, err
	}

	collections, err := s.collectionRepo.ListCollections(ctx, workspaceID, projectID)
	if err != nil {
		return nil, err
	}

	// Attach active items to each collection
	for _, col := range collections {
		items, err := s.collectionRepo.ListActiveItemsByCollection(ctx, col.ID)
		if err == nil {
			col.Items = items
		}
	}

	return collections, nil
}

// GetCollection gets collection by ID and verifies access
func (s *CollectionService) GetCollection(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.Collection, error) {
	col, err := s.collectionRepo.GetCollectionByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, false); err != nil {
		return nil, err
	}

	items, err := s.collectionRepo.ListActiveItemsByCollection(ctx, col.ID)
	if err == nil {
		col.Items = items
	}

	return col, nil
}

// UpdateCollection updates collection with OCC check
func (s *CollectionService) UpdateCollection(ctx context.Context, user *domain.User, c *domain.Collection, baseVersion int64) error {
	existing, err := s.collectionRepo.GetCollectionByID(ctx, c.ID)
	if err != nil {
		return err
	}

	if err := s.CheckPermission(ctx, user, existing.WorkspaceID, existing.ProjectID, true); err != nil {
		return err
	}

	c.LastModifiedBy = &user.ID
	return s.collectionRepo.UpdateCollection(ctx, c, baseVersion)
}

// DeleteCollection soft-deletes collection
func (s *CollectionService) DeleteCollection(ctx context.Context, user *domain.User, id uuid.UUID) error {
	col, err := s.collectionRepo.GetCollectionByID(ctx, id)
	if err != nil {
		return err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, true); err != nil {
		return err
	}

	return s.collectionRepo.SoftDeleteCollection(ctx, id, user.ID)
}

// CreateItem creates a request or folder
func (s *CollectionService) CreateItem(ctx context.Context, user *domain.User, item *domain.CollectionItem) error {
	col, err := s.collectionRepo.GetCollectionByID(ctx, item.CollectionID)
	if err != nil {
		return err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, true); err != nil {
		return err
	}

	item.LastModifiedBy = &user.ID
	return s.collectionRepo.CreateItem(ctx, item)
}

// UpdateItem updates a request or folder with OCC validation
func (s *CollectionService) UpdateItem(ctx context.Context, user *domain.User, item *domain.CollectionItem, baseVersion int64) (*domain.CollectionItem, error) {
	existing, err := s.collectionRepo.GetItemByID(ctx, item.ID)
	if err != nil {
		return nil, err
	}

	col, err := s.collectionRepo.GetCollectionByID(ctx, existing.CollectionID)
	if err != nil {
		return nil, err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, true); err != nil {
		return nil, err
	}

	item.LastModifiedBy = &user.ID
	err = s.collectionRepo.UpdateItem(ctx, item, baseVersion)
	if err != nil {
		if errors.Is(err, postgres.ErrVersionConflict) {
			// Re-fetch latest server item so client receives remote object for conflict resolution
			latest, _ := s.collectionRepo.GetItemByID(ctx, item.ID)
			return latest, err
		}
		return nil, err
	}

	return item, nil
}

// DeleteItem soft-deletes a request or folder
func (s *CollectionService) DeleteItem(ctx context.Context, user *domain.User, id uuid.UUID) error {
	item, err := s.collectionRepo.GetItemByID(ctx, id)
	if err != nil {
		return err
	}

	col, err := s.collectionRepo.GetCollectionByID(ctx, item.CollectionID)
	if err != nil {
		return err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, true); err != nil {
		return err
	}

	return s.collectionRepo.SoftDeleteItem(ctx, id, user.ID)
}

// GetItem gets an item by ID
func (s *CollectionService) GetItem(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.CollectionItem, error) {
	item, err := s.collectionRepo.GetItemByID(ctx, id)
	if err != nil {
		return nil, err
	}

	col, err := s.collectionRepo.GetCollectionByID(ctx, item.CollectionID)
	if err != nil {
		return nil, err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, false); err != nil {
		return nil, err
	}

	return item, nil
}

// ReorderItems updates sort order and parent folders for items within a collection
func (s *CollectionService) ReorderItems(ctx context.Context, user *domain.User, collectionID uuid.UUID, items []domain.ReorderItemPosition) ([]*domain.CollectionItem, error) {
	col, err := s.collectionRepo.GetCollectionByID(ctx, collectionID)
	if err != nil {
		return nil, err
	}

	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, true); err != nil {
		return nil, err
	}

	if err := s.collectionRepo.BatchReorderItems(ctx, collectionID, items, user.ID); err != nil {
		return nil, err
	}

	return s.collectionRepo.ListActiveItemsByCollection(ctx, collectionID)
}

