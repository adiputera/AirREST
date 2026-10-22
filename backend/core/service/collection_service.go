package service

import (
	"context"
	"errors"
	"fmt"
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
	projectRepo    *postgres.ProjectRepository
	projectService *ProjectService
}

func NewCollectionService(
	collectionRepo *postgres.CollectionRepository,
	workspaceRepo *postgres.WorkspaceRepository,
	projectRepo *postgres.ProjectRepository,
	projectService *ProjectService,
) *CollectionService {
	return &CollectionService{
		collectionRepo: collectionRepo,
		workspaceRepo:  workspaceRepo,
		projectRepo:    projectRepo,
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

// CanAccessCollection checks whether a user with a given project role meets the required min_role
func CanAccessCollection(userRole domain.ProjectRole, minRole domain.ProjectRole) bool {
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

// CheckCollectionAccess checks both container-level permissions and granular min_role on the collection
func (s *CollectionService) CheckCollectionAccess(ctx context.Context, user *domain.User, col *domain.Collection, requireWrite bool) error {
	if err := s.CheckPermission(ctx, user, col.WorkspaceID, col.ProjectID, requireWrite); err != nil {
		return err
	}

	if col.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *col.ProjectID)
		if err != nil {
			return ErrForbidden
		}
		if !CanAccessCollection(role, col.MinRole) {
			return ErrForbidden
		}
	}
	return nil
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

	if c.MinRole == "" {
		c.MinRole = domain.ProjectRoleReader
	}

	switch c.MinRole {
	case domain.ProjectRoleAdmin, domain.ProjectRoleMaintainer, domain.ProjectRoleContributor, domain.ProjectRoleReader:
	default:
		return errors.New("invalid min_role, must be admin, maintainer, contributor, or reader")
	}

	if c.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *c.ProjectID)
		if err != nil {
			return ErrForbidden
		}
		if !CanAccessCollection(role, c.MinRole) {
			return ErrForbidden
		}
	}

	c.CreatedBy = user.ID
	c.LastModifiedBy = &user.ID
	return s.collectionRepo.CreateCollection(ctx, c)
}

// ListCollections lists collections in workspace or project. If includeItems is false,
// only collection metadata (ID, name, role, version, timestamps) is returned, preventing
// payload overflow on serverless platforms. Detailed items can be retrieved 1-by-1 via GetCollection.
func (s *CollectionService) ListCollections(ctx context.Context, user *domain.User, workspaceID, projectID *uuid.UUID, includeItems bool) ([]*domain.Collection, error) {
	if err := s.CheckPermission(ctx, user, workspaceID, projectID, false); err != nil {
		return nil, err
	}

	collections, err := s.collectionRepo.ListCollections(ctx, workspaceID, projectID)
	if err != nil {
		return nil, err
	}

	// If project scoped and user is not superadmin, filter collections based on user's effective role
	if projectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *projectID)
		if err != nil {
			return nil, ErrForbidden
		}

		filtered := make([]*domain.Collection, 0, len(collections))
		for _, col := range collections {
			if CanAccessCollection(role, col.MinRole) {
				filtered = append(filtered, col)
			}
		}
		collections = filtered
	}

	// Optionally attach active items to each collection if explicitly requested
	if includeItems {
		for _, col := range collections {
			items, err := s.collectionRepo.ListActiveItemsByCollection(ctx, col.ID)
			if err == nil {
				col.Items = items
			}
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

	if col.DeletedAt != nil {
		return nil, postgres.ErrCollectionNotFound
	}

	if err := s.CheckCollectionAccess(ctx, user, col, false); err != nil {
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

	if existing.ProjectID != nil && !user.IsSuperadmin() {
		role, err := s.projectService.GetEffectiveRole(ctx, user, *existing.ProjectID)
		if err != nil {
			return ErrForbidden
		}
		if !CanAccessCollection(role, existing.MinRole) {
			return ErrForbidden
		}
		if c.MinRole != "" && !CanAccessCollection(role, c.MinRole) {
			return ErrForbidden
		}
	}

	if c.Name == "" {
		c.Name = existing.Name
	}
	if c.Description == nil {
		c.Description = existing.Description
	}
	if c.MinRole == "" {
		c.MinRole = existing.MinRole
	}
	if c.MinRole == "" {
		c.MinRole = domain.ProjectRoleReader
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

	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
		return err
	}

	return s.collectionRepo.SoftDeleteCollection(ctx, id, user.ID)
}

func isAtLeastContributor(role domain.ProjectRole) bool {
	switch role {
	case domain.ProjectRoleAdmin, domain.ProjectRoleMaintainer, domain.ProjectRoleContributor:
		return true
	default:
		return false
	}
}

// MoveCollection moves a collection to a target project (within the same team) or target workspace
func (s *CollectionService) MoveCollection(ctx context.Context, user *domain.User, collectionID uuid.UUID, targetWorkspaceID, targetProjectID *uuid.UUID) error {
	col, err := s.collectionRepo.GetCollectionByID(ctx, collectionID)
	if err != nil {
		return err
	}
	if col.DeletedAt != nil {
		return errors.New("cannot move deleted collection")
	}

	if targetWorkspaceID == nil && targetProjectID == nil {
		return errors.New("must specify either target_workspace_id or target_project_id")
	}
	if targetWorkspaceID != nil && targetProjectID != nil {
		return errors.New("cannot specify both target_workspace_id and target_project_id")
	}

	// Case 1: Moving to target project
	if targetProjectID != nil {
		if s.projectRepo == nil {
			return errors.New("project repository is not initialized")
		}

		targetProj, err := s.projectRepo.GetByID(ctx, *targetProjectID)
		if err != nil {
			return fmt.Errorf("target project not found: %w", err)
		}

		// Check target project role: user must be at least contributor
		targetRole, err := s.projectService.GetEffectiveRole(ctx, user, *targetProjectID)
		if err != nil || !isAtLeastContributor(targetRole) {
			return errors.New("at least contributor role required in target project")
		}

		// Check source
		if col.ProjectID != nil {
			if *col.ProjectID == *targetProjectID {
				return errors.New("collection is already in target project")
			}

			sourceProj, err := s.projectRepo.GetByID(ctx, *col.ProjectID)
			if err != nil {
				return fmt.Errorf("source project not found: %w", err)
			}

			// Scope rule: Must be in the same team!
			if sourceProj.TeamID != targetProj.TeamID {
				return errors.New("collections can only be moved between projects within the same team")
			}

			// Check source project role: user must be at least contributor and meet collection min_role
			sourceRole, err := s.projectService.GetEffectiveRole(ctx, user, *col.ProjectID)
			if err != nil || !isAtLeastContributor(sourceRole) || !CanAccessCollection(sourceRole, col.MinRole) {
				return errors.New("insufficient permission to move collection from source project")
			}
		} else if col.WorkspaceID != nil {
			// Moving from personal workspace to project
			ws, err := s.workspaceRepo.GetByID(ctx, *col.WorkspaceID)
			if err != nil {
				return err
			}
			if ws.OwnerID != user.ID && !user.IsSuperadmin() {
				return ErrForbidden
			}
		}

		return s.collectionRepo.MoveCollection(ctx, collectionID, nil, targetProjectID, user.ID)
	}

	// Case 2: Moving to target personal workspace
	if targetWorkspaceID != nil {
		targetWs, err := s.workspaceRepo.GetByID(ctx, *targetWorkspaceID)
		if err != nil {
			return fmt.Errorf("target workspace not found: %w", err)
		}
		if targetWs.OwnerID != user.ID && !user.IsSuperadmin() {
			return ErrForbidden
		}

		if col.WorkspaceID != nil {
			if *col.WorkspaceID == *targetWorkspaceID {
				return errors.New("collection is already in target workspace")
			}
			sourceWs, err := s.workspaceRepo.GetByID(ctx, *col.WorkspaceID)
			if err != nil {
				return err
			}
			if sourceWs.OwnerID != user.ID && !user.IsSuperadmin() {
				return ErrForbidden
			}
		} else if col.ProjectID != nil {
			sourceRole, err := s.projectService.GetEffectiveRole(ctx, user, *col.ProjectID)
			if err != nil || !isAtLeastContributor(sourceRole) || !CanAccessCollection(sourceRole, col.MinRole) {
				return errors.New("insufficient permission to move collection from source project")
			}
		}

		return s.collectionRepo.MoveCollection(ctx, collectionID, targetWorkspaceID, nil, user.ID)
	}

	return nil
}

// CreateItem creates a request or folder
func (s *CollectionService) CreateItem(ctx context.Context, user *domain.User, item *domain.CollectionItem) error {
	col, err := s.collectionRepo.GetCollectionByID(ctx, item.CollectionID)
	if err != nil {
		return err
	}

	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
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

	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
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

	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
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

	if item.DeletedAt != nil {
		return nil, postgres.ErrItemNotFound
	}

	col, err := s.collectionRepo.GetCollectionByID(ctx, item.CollectionID)
	if err != nil {
		return nil, err
	}

	if err := s.CheckCollectionAccess(ctx, user, col, false); err != nil {
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

	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
		return nil, err
	}

	if err := s.collectionRepo.BatchReorderItems(ctx, collectionID, items, user.ID); err != nil {
		return nil, err
	}

	return s.collectionRepo.ListActiveItemsByCollection(ctx, collectionID)
}

