package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
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

func TestBoundSyncPushResponsePreservesAppliedIDs(t *testing.T) {
	response := &SyncPushResponse{
		AppliedIDs: []uuid.UUID{uuid.New(), uuid.New()},
		Conflicts: []SyncConflictReport{{
			ID:         uuid.New(),
			Type:       "item",
			Message:    strings.Repeat("m", maxSyncConflictMessageBytes+1),
			ServerData: map[string]string{"body_content": strings.Repeat("x", MaxSyncPushResponseBytes)},
		}},
	}

	boundSyncPushResponse(response)

	if len(response.AppliedIDs) != 2 {
		t.Fatalf("applied IDs were lost: %#v", response.AppliedIDs)
	}
	if response.Conflicts[0].ServerData != nil {
		t.Fatal("oversized server data was not omitted")
	}
	if len(response.Conflicts[0].Message) > maxSyncConflictMessageBytes {
		t.Fatalf("message bytes=%d", len(response.Conflicts[0].Message))
	}
	encoded, err := json.Marshal(syncPushEnvelope{Success: true, Data: response})
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > MaxSyncPushResponseBytes {
		t.Fatalf("response bytes=%d", len(encoded))
	}
}
