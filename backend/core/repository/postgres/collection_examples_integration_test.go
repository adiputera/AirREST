package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

func TestCollectionExamplesRepository_PatchPaginationAndReplace(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := Connect(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	// Idempotent migration re-run should succeed cleanly.
	if err := runMigrations(ctx, pool); err != nil {
		t.Fatalf("idempotent migration re-run failed: %v", err)
	}

	userID := uuid.New()
	wsID := uuid.New()
	colID := uuid.New()
	folderID := uuid.New()
	req1ID := uuid.New()
	req2ID := uuid.New()

	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, 'hash', 'Tester', 'user')`,
		userID, "ex-"+userID.String()+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspaces (id, owner_id, name, is_default) VALUES ($1, $2, 'WS', TRUE)`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collections (id, workspace_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Col', 'reader', 1, $3, $3)`,
		colID, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, last_modified_by) VALUES ($1, $2, NULL, 'folder', 'F', 5, $3)`,
		folderID, colID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, method, url, last_modified_by) VALUES ($1, $2, $3, 'request', 'Req 1', 10, 'GET', 'https://example.com/1', $4)`,
		req1ID, colID, folderID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, method, url, last_modified_by) VALUES ($1, $2, NULL, 'request', 'Req 2', 30, 'POST', 'https://example.com/2', $3)`,
		req2ID, colID, userID); err != nil {
		t.Fatal(err)
	}

	// Constraint check: folder cannot hold non-empty examples.
	if _, err := pool.Exec(ctx, `UPDATE collection_items SET examples = '[{"id":"x"}]'::jsonb WHERE id = $1`, folderID); err == nil {
		t.Fatal("expected folder examples constraint to reject non-empty array")
	}

	repo := NewCollectionRepository(pool)

	// 1. PatchItemExamples add + idempotent replay + sort_order/parent preservation
	addOpID := uuid.New()
	addRaw := json.RawMessage(`[{"id":"ex-1","revision":1,"name":"200 OK","status":"OK","code":200,"header":[{"key":"Content-Type","value":"application/json"}],"cookie":[],"body":"{\"ok\":true}","_postman_previewlanguage":"json"}]`)
	added, err := repo.PatchItemExamples(
		ctx, userID, req1ID, addOpID, "add", "fp-add-1", 1,
		func(_ domain.ItemType, _ domain.OptionalRawJSON) (json.RawMessage, error) {
			return addRaw, nil
		},
		nil,
	)
	if err != nil {
		t.Fatalf("PatchItemExamples add failed: %v", err)
	}
	if added.Version != 2 || added.SortOrder != 10 || added.ParentID == nil || *added.ParentID != folderID {
		t.Fatalf("unexpected item state after add: version=%d sort=%d parent=%v", added.Version, added.SortOrder, added.ParentID)
	}

	// Replay same operation_id + fingerprint with stale base_version=1 must succeed idempotently.
	replayedAdd, err := repo.PatchItemExamples(
		ctx, userID, req1ID, addOpID, "add", "fp-add-1", 1,
		func(_ domain.ItemType, _ domain.OptionalRawJSON) (json.RawMessage, error) {
			t.Fatal("mutate callback must not run on receipt replay")
			return nil, nil
		},
		nil,
	)
	if err != nil || replayedAdd.Version != 2 {
		t.Fatalf("expected idempotent replay v2, got err=%v item=%+v", err, replayedAdd)
	}

	// Reusing operation_id with different fingerprint must return ErrVersionConflict.
	if _, err := repo.PatchItemExamples(ctx, userID, req1ID, addOpID, "add", "fp-other", 1, nil, nil); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict on mismatched fingerprint, got %v", err)
	}

	// 2. PatchItemExamples rename + delete + replay
	renameOpID := uuid.New()
	renameRaw := json.RawMessage(`[{"id":"ex-1","revision":2,"name":"Renamed","status":"OK","code":200,"header":[{"key":"Content-Type","value":"application/json"}],"cookie":[],"body":"{\"ok\":true}","_postman_previewlanguage":"json"}]`)
	renamed, err := repo.PatchItemExamples(
		ctx, userID, req1ID, renameOpID, "rename", "fp-ren-1", 2,
		func(_ domain.ItemType, _ domain.OptionalRawJSON) (json.RawMessage, error) {
			return renameRaw, nil
		},
		nil,
	)
	if err != nil || renamed.Version != 3 {
		t.Fatalf("PatchItemExamples rename failed: err=%v item=%+v", err, renamed)
	}

	deleteOpID := uuid.New()
	deleted, err := repo.PatchItemExamples(
		ctx, userID, req1ID, deleteOpID, "delete", "fp-del-1", 3,
		func(_ domain.ItemType, _ domain.OptionalRawJSON) (json.RawMessage, error) {
			return json.RawMessage(`[]`), nil
		},
		nil,
	)
	if err != nil || deleted.Version != 4 {
		t.Fatalf("PatchItemExamples delete failed: err=%v item=%+v", err, deleted)
	}
	if replayedDel, err := repo.PatchItemExamples(ctx, userID, req1ID, deleteOpID, "delete", "fp-del-1", 3, nil, nil); err != nil || replayedDel.Version != 4 {
		t.Fatalf("delete replay failed: err=%v item=%+v", err, replayedDel)
	}

	// Verify sibling sort_order untouched
	sib, err := repo.GetItemByID(ctx, req2ID)
	if err != nil || sib.SortOrder != 30 {
		t.Fatalf("expected sibling sort_order=30 intact, got err=%v sib=%+v", err, sib)
	}

	// 3. ListCollectionExamplesPage cursor pagination across RepeatableRead snapshot
	colVer, page1, err := repo.ListCollectionExamplesPage(ctx, colID, nil, 1)
	if err != nil || len(page1) != 1 || page1[0].ItemID != req1ID || colVer < 4 {
		t.Fatalf("unexpected page1: ver=%d rows=%+v err=%v", colVer, page1, err)
	}
	cursor := EncodeExamplesCursor(CollectionExamplesCursor{
		SortOrder: page1[0].SortOrder,
		CreatedAt: page1[0].CreatedAt,
		ID:        page1[0].ItemID,
	})
	decodedCursor, err := DecodeExamplesCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	_, page2, err := repo.ListCollectionExamplesPage(ctx, colID, decodedCursor, 5)
	if err != nil || len(page2) != 1 || page2[0].ItemID != req2ID {
		t.Fatalf("unexpected page2: rows=%+v err=%v", page2, err)
	}

	// 4. ReplaceCollectionAtomic soft-deletes omitted items, upserts new items, and replays idempotently
	replaceOpID := uuid.New()
	newReqID := uuid.New()
	methodGet := "GET"
	urlNew := "https://example.com/replaced"
	receipt, err := repo.ReplaceCollectionAtomic(
		ctx,
		userID,
		colID,
		replaceOpID,
		"fp-replace-1",
		colVer,
		"Replaced Col",
		nil,
		[]ReplaceFlatItem{
			{
				ID:        req1ID,
				Type:      domain.ItemTypeRequest,
				Name:      "Req 1 Updated",
				SortOrder: 0,
				Method:    &methodGet,
				URL:       &urlNew,
				Examples:  addRaw,
			},
			{
				ID:        newReqID,
				Type:      domain.ItemTypeRequest,
				Name:      "Req New",
				SortOrder: 1,
				Method:    &methodGet,
				URL:       &urlNew,
				Examples:  json.RawMessage("[]"),
			},
		},
		nil,
	)
	if err != nil {
		t.Fatalf("ReplaceCollectionAtomic failed: %v", err)
	}
	if receipt.Version != colVer+1 || receipt.ItemCount != 2 {
		t.Fatalf("unexpected replace receipt: %+v", receipt)
	}

	// Replay with same operation_id + fingerprint must return same receipt without error.
	replayedReceipt, err := repo.ReplaceCollectionAtomic(ctx, userID, colID, replaceOpID, "fp-replace-1", colVer, "Replaced Col", nil, nil, nil)
	if err != nil || replayedReceipt.Version != receipt.Version {
		t.Fatalf("replace replay failed: err=%v receipt=%+v", err, replayedReceipt)
	}

	// Different fingerprint with same operation_id must fail with ErrVersionConflict.
	if _, err := repo.ReplaceCollectionAtomic(ctx, userID, colID, replaceOpID, "fp-replace-other", colVer, "Replaced Col", nil, nil, nil); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("expected ErrVersionConflict for mismatched replace fingerprint, got %v", err)
	}

	// Omitted items (folderID and req2ID) must be soft-deleted.
	activeItems, err := repo.ListActiveItemsByCollection(ctx, colID)
	if err != nil || len(activeItems) != 2 {
		t.Fatalf("expected 2 active items after replace, got len=%d err=%v", len(activeItems), err)
	}
}
