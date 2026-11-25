package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

type PatchItemExamplesInput struct {
	OperationID         uuid.UUID            `json:"operation_id"`
	Op                  string               `json:"op"`
	BaseVersion         int64                `json:"base_version"`
	Example             *domain.SavedExample `json:"example,omitempty"`
	ExampleID           string               `json:"example_id,omitempty"`
	BaseExampleRevision int64                `json:"base_example_revision,omitempty"`
	Name                string               `json:"name,omitempty"`
}

type CollectionExamplePageItem struct {
	ItemID           uuid.UUID                    `json:"item_id"`
	ItemVersion      int64                        `json:"item_version"`
	ExampleCount     int                          `json:"example_count"`
	ExamplesLoaded   bool                         `json:"examples_loaded"`
	ExampleSummaries []domain.SavedExampleSummary `json:"example_summaries,omitempty"`
	Examples         []domain.SavedExample        `json:"examples,omitempty"`
}

type CollectionExamplesPage struct {
	CollectionID      uuid.UUID                   `json:"collection_id"`
	CollectionVersion int64                       `json:"collection_version"`
	Items             []CollectionExamplePageItem `json:"items"`
	NextCursor        string                      `json:"next_cursor,omitempty"`
	HasMore           bool                        `json:"has_more"`
}

type ReplaceCollectionInput struct {
	OperationID uuid.UUID               `json:"operation_id"`
	BaseVersion int64                   `json:"base_version"`
	Collection  ImportCollectionRequest `json:"collection"`
}

func computeSHA256Fingerprint(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// PatchItemExamples applies a single add/rename/delete saved example operation atomically with OCC and receipt replay.
func (s *CollectionService) PatchItemExamples(
	ctx context.Context,
	user *domain.User,
	itemID uuid.UUID,
	req PatchItemExamplesInput,
) (*domain.CollectionItem, error) {
	if user == nil || user.ID == uuid.Nil {
		return nil, ErrForbidden
	}
	if req.OperationID == uuid.Nil {
		return nil, newValidationError("operation_id", "valid operation_id is required")
	}
	if req.BaseVersion < 1 {
		return nil, newValidationError("base_version", "base_version must be >= 1")
	}
	op := strings.ToLower(strings.TrimSpace(req.Op))
	if op != "add" && op != "rename" && op != "delete" {
		return nil, newValidationError("op", "op must be 'add', 'rename', or 'delete'")
	}

	var normalizedAdd domain.SavedExample
	var trimmedRename string
	var err error
	switch op {
	case "add":
		if req.Example == nil {
			return nil, newValidationError("example", "example object is required for add")
		}
		exCopy := *req.Example
		if strings.TrimSpace(exCopy.ID) == "" {
			exCopy.ID = uuid.NewString()
		}
		exCopy.Revision = 1
		normalizedAdd, err = ValidateSingleSavedExample(exCopy, nil)
		if err != nil {
			return nil, err
		}
	case "rename":
		if strings.TrimSpace(req.ExampleID) == "" {
			return nil, newValidationError("example_id", "example_id is required")
		}
		if req.BaseExampleRevision < 1 {
			return nil, newValidationError("base_example_revision", "base_example_revision must be >= 1")
		}
		trimmedRename, err = ValidateSavedExampleName(req.Name)
		if err != nil {
			return nil, err
		}
	case "delete":
		if strings.TrimSpace(req.ExampleID) == "" {
			return nil, newValidationError("example_id", "example_id is required")
		}
		if req.BaseExampleRevision < 1 {
			return nil, newValidationError("base_example_revision", "base_example_revision must be >= 1")
		}
	}

	item, err := s.collectionRepo.GetItemByID(ctx, itemID)
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
	if col.DeletedAt != nil {
		return nil, postgres.ErrCollectionNotFound
	}
	if err := s.CheckCollectionAccess(ctx, user, col, true); err != nil {
		return nil, err
	}
	if item.Type == domain.ItemTypeFolder {
		return nil, newValidationError("examples", "folders cannot contain saved examples")
	}

	fingerprint, err := computeSHA256Fingerprint(struct {
		ItemID uuid.UUID `json:"item_id"`
		Op     string    `json:"op"`
		ExID   string    `json:"ex_id,omitempty"`
		Rev    int64     `json:"rev,omitempty"`
		Name   string    `json:"name,omitempty"`
		BodyID string    `json:"body_id,omitempty"`
		Add    any       `json:"add,omitempty"`
	}{
		ItemID: itemID,
		Op:     op,
		ExID:   req.ExampleID,
		Rev:    req.BaseExampleRevision,
		Name:   trimmedRename,
		Add:    normalizedAdd,
	})
	if err != nil {
		return nil, err
	}

	return s.collectionRepo.PatchItemExamples(
		ctx,
		user.ID,
		itemID,
		req.OperationID,
		op,
		fingerprint,
		req.BaseVersion,
		func(itemType domain.ItemType, current domain.OptionalRawJSON) (json.RawMessage, error) {
			if itemType != domain.ItemTypeRequest {
				return nil, newValidationError("examples", "only request items can hold saved examples")
			}
			list, parseErr := ParseStoredExamples(current)
			if parseErr != nil {
				list = []domain.SavedExample{}
			}

			switch op {
			case "add":
				for _, ex := range list {
					if ex.ID == normalizedAdd.ID {
						return nil, newValidationError("examples.id", "example with this id already exists")
					}
				}
				if len(list) >= MaxSavedExamplesPerItem {
					return nil, fmt.Errorf("%w: item already has maximum %d saved examples", ErrExampleLimitExceeded, MaxSavedExamplesPerItem)
				}
				list = append(list, normalizedAdd)
			case "rename":
				found := false
				for i := range list {
					if list[i].ID == req.ExampleID {
						rev := list[i].Revision
						if rev < 1 {
							rev = 1
						}
						if rev != req.BaseExampleRevision {
							return nil, fmt.Errorf("%w: saved example revision mismatch", ErrExampleConflict)
						}
						list[i].Name = trimmedRename
						list[i].Revision = rev + 1
						found = true
						break
					}
				}
				if !found {
					return nil, fmt.Errorf("%w: saved example no longer exists", ErrExampleConflict)
				}
			case "delete":
				idx := -1
				for i := range list {
					if list[i].ID == req.ExampleID {
						rev := list[i].Revision
						if rev < 1 {
							rev = 1
						}
						if rev != req.BaseExampleRevision {
							return nil, fmt.Errorf("%w: saved example revision mismatch", ErrExampleConflict)
						}
						idx = i
						break
					}
				}
				if idx == -1 {
					return nil, fmt.Errorf("%w: saved example no longer exists", ErrExampleConflict)
				}
				list = append(list[:idx], list[idx+1:]...)
			}

			encoded, encErr := json.Marshal(list)
			if encErr != nil {
				return nil, newValidationError("examples", "failed to serialize saved examples")
			}
			if len(encoded) > MaxSavedExamplesTotalBytesPerItm {
				return nil, fmt.Errorf("%w: total examples payload exceeds %d MiB limit", ErrExampleLimitExceeded, MaxSavedExamplesTotalBytesPerItm/(1024*1024))
			}
			return json.RawMessage(encoded), nil
		},
		MarkItemFullExamples,
	)
}

// GetCollectionExamples returns cursor-paginated summaries or full examples for a collection within safe response size budgets.
func (s *CollectionService) GetCollectionExamples(
	ctx context.Context,
	user *domain.User,
	collectionID uuid.UUID,
	cursorRaw string,
	limit int,
	includeBody bool,
) (*CollectionExamplesPage, error) {
	col, err := s.collectionRepo.GetCollectionByID(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	if col.DeletedAt != nil {
		return nil, postgres.ErrCollectionNotFound
	}
	if err := s.CheckCollectionAccess(ctx, user, col, false); err != nil {
		return nil, err
	}

	cursor, err := postgres.DecodeExamplesCursor(cursorRaw)
	if err != nil {
		return nil, newValidationError("cursor", err.Error())
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	colVersion, rows, err := s.collectionRepo.ListCollectionExamplesPage(ctx, collectionID, cursor, limit+1)
	if err != nil {
		return nil, err
	}

	page := &CollectionExamplesPage{
		CollectionID:      collectionID,
		CollectionVersion: colVersion,
		Items:             make([]CollectionExamplePageItem, 0, len(rows)),
		HasMore:           false,
	}

	usedBytes := 0
	var lastRow *postgres.CollectionExampleRawRow
	for i := range rows {
		if i == limit {
			page.HasMore = true
			break
		}
		row := rows[i]
		examples, parseErr := ParseStoredExamples(row.Examples)
		if parseErr != nil {
			examples = []domain.SavedExample{}
		}
		entry := CollectionExamplePageItem{
			ItemID:           row.ItemID,
			ItemVersion:      row.ItemVersion,
			ExampleCount:     len(examples),
			ExamplesLoaded:   includeBody || len(examples) == 0,
			ExampleSummaries: BuildExampleSummaries(examples),
		}
		if includeBody {
			entry.Examples = examples
		}
		entryBytes, _ := json.Marshal(&entry)
		if len(page.Items) > 0 && usedBytes+len(entryBytes) > MaxSummaryResponseBudgetBytes {
			page.HasMore = true
			break
		}
		usedBytes += len(entryBytes)
		page.Items = append(page.Items, entry)
		rCopy := row
		lastRow = &rCopy
	}

	if page.HasMore && lastRow != nil {
		page.NextCursor = postgres.EncodeExamplesCursor(postgres.CollectionExamplesCursor{
			SortOrder: lastRow.SortOrder,
			CreatedAt: lastRow.CreatedAt,
			ID:        lastRow.ItemID,
		})
	}

	return page, nil
}

// ReplaceCollection atomically replaces a collection's hierarchy and items under OCC + operation_id idempotency.
func (s *CollectionService) ReplaceCollection(
	ctx context.Context,
	user *domain.User,
	collectionID uuid.UUID,
	req ReplaceCollectionInput,
) (*postgres.ReplaceCollectionReceipt, error) {
	if user == nil || user.ID == uuid.Nil {
		return nil, ErrForbidden
	}
	if req.OperationID == uuid.Nil {
		return nil, newValidationError("operation_id", "valid operation_id is required")
	}
	if req.BaseVersion < 1 {
		return nil, newValidationError("base_version", "base_version must be >= 1")
	}
	trimmedName := strings.TrimSpace(req.Collection.Name)
	if err := ValidateName(trimmedName); err != nil {
		return nil, err
	}
	req.Collection.Name = trimmedName
	if err := validateImport([]ImportCollectionRequest{req.Collection}); err != nil {
		return nil, err
	}

	var flatItems []postgres.ReplaceFlatItem
	seenIDs := make(map[uuid.UUID]struct{})
	var flatten func(list []ImportItemRequest, parentID *uuid.UUID)
	flatten = func(list []ImportItemRequest, parentID *uuid.UUID) {
		for idx, it := range list {
			itemID, err := uuid.Parse(it.ID)
			if err != nil || itemID == uuid.Nil {
				itemID = uuid.New()
			}
			for _, exists := seenIDs[itemID]; exists; _, exists = seenIDs[itemID] {
				itemID = uuid.New()
			}
			seenIDs[itemID] = struct{}{}

			itemType := domain.ItemType(it.Type)
			if itemType == "" {
				itemType = domain.ItemTypeRequest
			}
			exBytes := json.RawMessage("[]")
			if itemType == domain.ItemTypeRequest && it.Examples.Present && !it.Examples.IsNull && len(it.Examples.Raw) > 0 {
				exBytes = it.Examples.Raw
			}
			sortOrder := it.SortOrder
			if sortOrder == 0 && idx > 0 {
				sortOrder = idx
			}
			flatItems = append(flatItems, postgres.ReplaceFlatItem{
				ID:                 itemID,
				ParentID:           parentID,
				Type:               itemType,
				Name:               strings.TrimSpace(it.Name),
				SortOrder:          sortOrder,
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
				Examples:           exBytes,
			})
			if len(it.Items) > 0 {
				pid := itemID
				flatten(it.Items, &pid)
			}
		}
	}
	flatten(req.Collection.Items, nil)

	fingerprint, err := computeSHA256Fingerprint(struct {
		CollectionID uuid.UUID               `json:"collection_id"`
		BaseVersion  int64                   `json:"base_version"`
		Collection   ImportCollectionRequest `json:"collection"`
	}{
		CollectionID: collectionID,
		BaseVersion:  req.BaseVersion,
		Collection:   req.Collection,
	})
	if err != nil {
		return nil, err
	}

	return s.collectionRepo.ReplaceCollectionAtomic(
		ctx,
		user.ID,
		collectionID,
		req.OperationID,
		fingerprint,
		req.BaseVersion,
		trimmedName,
		req.Collection.Description,
		flatItems,
		func(lockedCol *domain.Collection) error {
			return s.CheckCollectionAccess(ctx, user, lockedCol, true)
		},
	)
}
