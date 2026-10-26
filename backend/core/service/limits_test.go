package service

import (
	"context"
	"errors"
	"testing"
)

func TestBatchLimitsBeforeIO(t *testing.T) {
	s := &SyncService{}
	if _, err := s.PushChangeset(context.Background(), nil, SyncPushRequest{Items: make([]SyncItemMutation, MaxSyncMutations+1)}); !errors.Is(err, ErrBatchLimit) {
		t.Fatalf("mutation limit: %v", err)
	}
	for _, cols := range [][]ImportCollectionRequest{
		make([]ImportCollectionRequest, MaxImportCollections+1),
		{{Items: make([]ImportItemRequest, MaxImportItems+1)}},
	} {
		if !errors.Is(validateImport(cols), ErrBatchLimit) {
			t.Fatal("accepted oversized import")
		}
	}
	nested := []ImportItemRequest{{Name: "leaf"}}
	for range MaxImportDepth {
		nested = []ImportItemRequest{{Items: nested}}
	}
	if !errors.Is(validateImport([]ImportCollectionRequest{{Items: nested}}), ErrBatchLimit) {
		t.Fatal("accepted deep import")
	}
	if err := validateImport([]ImportCollectionRequest{{Items: []ImportItemRequest{{Name: "valid"}}}}); err != nil {
		t.Fatal(err)
	}
}
