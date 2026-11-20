package service

import (
	"context"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

func (s *CollectionService) MoveItem(ctx context.Context, user *domain.User, id, sourceID, targetID uuid.UUID, parentID *uuid.UUID) error {
	source, err := s.collectionRepo.GetCollectionByID(ctx, sourceID)
	if err != nil {
		return err
	}
	target, err := s.collectionRepo.GetCollectionByID(ctx, targetID)
	if err != nil {
		return err
	}
	for _, col := range []*domain.Collection{source, target} {
		if col.DeletedAt != nil {
			return postgres.ErrCollectionNotFound
		}
		if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
			return err
		}
	}
	sameWorkspace := source.WorkspaceID != nil && target.WorkspaceID != nil && *source.WorkspaceID == *target.WorkspaceID
	sameProject := source.ProjectID != nil && target.ProjectID != nil && *source.ProjectID == *target.ProjectID
	if !sameWorkspace && !sameProject {
		return postgres.ErrInvalidItemMove
	}
	return s.collectionRepo.MoveItem(ctx, id, source, target, parentID, user.ID)
}
