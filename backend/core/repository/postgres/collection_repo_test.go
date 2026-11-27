package postgres

import (
	"errors"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

func TestValidateBatchReorderHierarchy(t *testing.T) {
	folderA := uuid.New()
	folderB := uuid.New()
	folderC := uuid.New()
	reqItem := uuid.New()

	baseNodes := map[uuid.UUID]reorderTreeNode{
		folderA: {ID: folderA, ParentID: nil, Type: domain.ItemTypeFolder},
		folderB: {ID: folderB, ParentID: &folderA, Type: domain.ItemTypeFolder},
		folderC: {ID: folderC, ParentID: &folderB, Type: domain.ItemTypeFolder},
		reqItem: {ID: reqItem, ParentID: &folderC, Type: domain.ItemTypeRequest},
	}

	t.Run("accepts valid acyclic reparenting within depth cap", func(t *testing.T) {
		err := ValidateBatchReorderHierarchy(baseNodes, []domain.ReorderItemPosition{
			{ID: folderC, ParentID: &folderA, SortOrder: 0},
			{ID: reqItem, ParentID: &folderB, SortOrder: 1},
		})
		if err != nil {
			t.Fatalf("expected valid reorder, got %v", err)
		}
	})

	t.Run("rejects two-node folder cycle A <-> B", func(t *testing.T) {
		err := ValidateBatchReorderHierarchy(baseNodes, []domain.ReorderItemPosition{
			{ID: folderA, ParentID: &folderB, SortOrder: 0},
			{ID: folderB, ParentID: &folderA, SortOrder: 0},
		})
		if !errors.Is(err, ErrInvalidReorder) {
			t.Fatalf("expected ErrInvalidReorder, got %v", err)
		}
	})

	t.Run("rejects ancestor moved into descendant folder", func(t *testing.T) {
		err := ValidateBatchReorderHierarchy(baseNodes, []domain.ReorderItemPosition{
			{ID: folderA, ParentID: &folderC, SortOrder: 0},
		})
		if !errors.Is(err, ErrInvalidReorder) {
			t.Fatalf("expected ErrInvalidReorder, got %v", err)
		}
	})

	t.Run("rejects non-folder parent", func(t *testing.T) {
		err := ValidateBatchReorderHierarchy(baseNodes, []domain.ReorderItemPosition{
			{ID: folderB, ParentID: &reqItem, SortOrder: 0},
		})
		if !errors.Is(err, ErrInvalidReorder) {
			t.Fatalf("expected ErrInvalidReorder, got %v", err)
		}
	})

	t.Run("rejects hierarchy exceeding maxItemMoveDepth", func(t *testing.T) {
		deepNodes := make(map[uuid.UUID]reorderTreeNode)
		var prev *uuid.UUID
		var ids []uuid.UUID
		for i := 0; i < maxItemMoveDepth; i++ {
			id := uuid.New()
			ids = append(ids, id)
			deepNodes[id] = reorderTreeNode{ID: id, ParentID: prev, Type: domain.ItemTypeFolder}
			pid := id
			prev = &pid
		}
		extra := uuid.New()
		deepNodes[extra] = reorderTreeNode{ID: extra, ParentID: nil, Type: domain.ItemTypeRequest}

		err := ValidateBatchReorderHierarchy(deepNodes, []domain.ReorderItemPosition{
			{ID: extra, ParentID: &ids[len(ids)-1], SortOrder: 0},
		})
		if !errors.Is(err, ErrInvalidReorder) {
			t.Fatalf("expected ErrInvalidReorder for depth %d, got %v", maxItemMoveDepth+1, err)
		}
	})
}
