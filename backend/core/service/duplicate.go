package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

type ImportDuplicateCollectionPayload struct {
	Name        string              `json:"name"`
	Description *string             `json:"description,omitempty"`
	Items       []ImportItemRequest `json:"items,omitempty"`
}

type DuplicateService struct {
	repo *postgres.DuplicateRepository
}

func NewDuplicateService(repo *postgres.DuplicateRepository) *DuplicateService {
	return &DuplicateService{repo: repo}
}

func computeDuplicateFingerprint(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func (s *DuplicateService) DuplicateCollection(
	ctx context.Context,
	user *domain.User,
	sourceCollectionID uuid.UUID,
	targetWorkspaceID, targetProjectID *uuid.UUID,
	operationID uuid.UUID,
) (*postgres.DuplicateCollectionReceipt, error) {
	if user == nil || user.ID == uuid.Nil {
		return nil, postgres.ErrDuplicateForbidden
	}
	if sourceCollectionID == uuid.Nil || operationID == uuid.Nil {
		return nil, &postgres.DuplicateValidationError{Message: "source collection id and operation_id are required"}
	}
	if (targetWorkspaceID == nil) == (targetProjectID == nil) {
		return nil, &postgres.DuplicateValidationError{Message: "exactly one of target_workspace_id or target_project_id is required"}
	}
	if s.repo == nil {
		return nil, errors.New("duplicate repository is not initialized")
	}

	fingerprint, err := computeDuplicateFingerprint(struct {
		Kind               string     `json:"kind"`
		SourceCollectionID uuid.UUID  `json:"source_collection_id"`
		TargetWorkspaceID  *uuid.UUID `json:"target_workspace_id,omitempty"`
		TargetProjectID    *uuid.UUID `json:"target_project_id,omitempty"`
	}{
		Kind:               "collection",
		SourceCollectionID: sourceCollectionID,
		TargetWorkspaceID:  targetWorkspaceID,
		TargetProjectID:    targetProjectID,
	})
	if err != nil {
		return nil, err
	}

	return s.repo.DuplicateCollection(ctx, user, sourceCollectionID, targetWorkspaceID, targetProjectID, operationID, fingerprint)
}

func (s *DuplicateService) ImportDuplicateCollection(
	ctx context.Context,
	user *domain.User,
	targetWorkspaceID, targetProjectID *uuid.UUID,
	operationID uuid.UUID,
	col ImportDuplicateCollectionPayload,
) (*postgres.DuplicateCollectionReceipt, error) {
	if user == nil || user.ID == uuid.Nil {
		return nil, postgres.ErrDuplicateForbidden
	}
	if operationID == uuid.Nil {
		return nil, &postgres.DuplicateValidationError{Message: "operation_id is required"}
	}
	if (targetWorkspaceID == nil) == (targetProjectID == nil) {
		return nil, &postgres.DuplicateValidationError{Message: "exactly one of target_workspace_id or target_project_id is required"}
	}
	if err := ValidateName(col.Name); err != nil {
		return nil, err
	}
	col.Name = strings.TrimSpace(col.Name)

	// Validate item/depth limits and every item payload before touching DB.
	total := 0
	var checkLimits func([]ImportItemRequest, int) error
	checkLimits = func(items []ImportItemRequest, depth int) error {
		if len(items) == 0 {
			return nil
		}
		if depth > MaxImportDepth {
			return &postgres.DuplicateLimitError{Message: "duplicate exceeds maximum folder depth of 32 levels"}
		}
		total += len(items)
		if total > MaxImportItems {
			return &postgres.DuplicateLimitError{Message: "duplicate exceeds maximum limit of 5000 items"}
		}
		for _, item := range items {
			if err := checkLimits(item.Items, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := checkLimits(col.Items, 1); err != nil {
		return nil, err
	}

	converted, err := validateAndConvertImportDuplicateItems(col.Items)
	if err != nil {
		return nil, err
	}
	if s.repo == nil {
		return nil, errors.New("duplicate repository is not initialized")
	}

	fingerprint, err := computeDuplicateFingerprint(struct {
		Kind              string                           `json:"kind"`
		TargetWorkspaceID *uuid.UUID                       `json:"target_workspace_id,omitempty"`
		TargetProjectID   *uuid.UUID                       `json:"target_project_id,omitempty"`
		Collection        ImportDuplicateCollectionPayload `json:"collection"`
	}{
		Kind:              "import_duplicate",
		TargetWorkspaceID: targetWorkspaceID,
		TargetProjectID:   targetProjectID,
		Collection:        col,
	})
	if err != nil {
		return nil, err
	}

	return s.repo.ImportDuplicateCollection(ctx, user, targetWorkspaceID, targetProjectID, operationID, fingerprint, col.Name, col.Description, converted)
}

func validateAndConvertImportDuplicateItems(items []ImportItemRequest) ([]postgres.DuplicateImportItem, error) {
	if len(items) == 0 {
		return nil, nil
	}
	out := make([]postgres.DuplicateImportItem, 0, len(items))
	for _, it := range items {
		if err := ValidateImportItem(&it); err != nil {
			return nil, err
		}
		itemType := domain.ItemType(it.Type)
		if itemType == "" {
			itemType = domain.ItemTypeRequest
		}
		children, err := validateAndConvertImportDuplicateItems(it.Items)
		if err != nil {
			return nil, err
		}
		out = append(out, postgres.DuplicateImportItem{
			Type:               itemType,
			Name:               strings.TrimSpace(it.Name),
			SortOrder:          it.SortOrder,
			Method:             it.Method,
			URL:                it.URL,
			Params:             it.Params,
			PathVariables:      it.PathVariables,
			Headers:            it.Headers,
			Auth:               it.Auth,
			BodyType:           it.BodyType,
			RawType:            it.RawType,
			BodyContent:        it.BodyContent,
			GraphQLQuery:       it.GraphQLQuery,
			GraphQLVariables:   it.GraphQLVariables,
			BodyFormData:       it.BodyFormData,
			PreRequestScript:   it.PreRequestScript,
			PostResponseScript: it.PostResponseScript,
			Examples:           it.Examples,
			Items:              children,
		})
	}
	return out, nil
}

func (s *DuplicateService) DuplicateItem(
	ctx context.Context,
	user *domain.User,
	itemID, sourceCollectionID, targetCollectionID uuid.UUID,
	targetParentID *uuid.UUID,
	operationID uuid.UUID,
) (*postgres.DuplicateItemReceipt, error) {
	if user == nil || user.ID == uuid.Nil {
		return nil, postgres.ErrDuplicateForbidden
	}
	if itemID == uuid.Nil || sourceCollectionID == uuid.Nil || targetCollectionID == uuid.Nil || operationID == uuid.Nil {
		return nil, &postgres.DuplicateValidationError{Message: "item id, source_collection_id, target_collection_id, and operation_id are required"}
	}
	if targetParentID != nil && *targetParentID == uuid.Nil {
		return nil, &postgres.DuplicateValidationError{Message: "invalid target_parent_id"}
	}
	if s.repo == nil {
		return nil, errors.New("duplicate repository is not initialized")
	}

	fingerprint, err := computeDuplicateFingerprint(struct {
		Kind               string     `json:"kind"`
		ItemID             uuid.UUID  `json:"item_id"`
		SourceCollectionID uuid.UUID  `json:"source_collection_id"`
		TargetCollectionID uuid.UUID  `json:"target_collection_id"`
		TargetParentID     *uuid.UUID `json:"target_parent_id,omitempty"`
	}{
		Kind:               "item",
		ItemID:             itemID,
		SourceCollectionID: sourceCollectionID,
		TargetCollectionID: targetCollectionID,
		TargetParentID:     targetParentID,
	})
	if err != nil {
		return nil, err
	}

	return s.repo.DuplicateItem(ctx, user, itemID, sourceCollectionID, targetCollectionID, targetParentID, operationID, fingerprint)
}
