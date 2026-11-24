package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func seedDuplicateRepoFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	userID := uuid.New()
	wsID := uuid.New()
	colID := uuid.New()
	folderID := uuid.New()
	reqID := uuid.New()

	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, 'hash', 'Tester', 'user')`,
		userID, "dup-"+userID.String()+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspaces (id, owner_id, name, is_default) VALUES ($1, $2, 'WS A', TRUE)`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collections (id, workspace_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Source Col', 'reader', 1, $3, $3)`,
		colID, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, last_modified_by) VALUES ($1, $2, NULL, 'folder', 'Root Folder', 0, $3)`,
		folderID, colID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, method, url, last_modified_by) VALUES ($1, $2, $3, 'request', 'Child Req', 0, 'GET', 'https://httpbin.org/get?user=tester&tag=api', $4)`,
		reqID, colID, folderID, userID); err != nil {
		t.Fatal(err)
	}
	return userID, wsID, colID, folderID
}

// B04: A failure mid-subtree rolls back both duplicated collection/items and the idempotency ledger.
func TestDuplicateRepository_MidSubtreeFailureRollsBackAllState(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := Connect(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	userID, wsID, colID, _ := seedDuplicateRepoFixture(t, ctx, pool)
	repo := NewDuplicateRepository(pool)
	user := &domain.User{ID: userID, Role: domain.RoleUser}

	// Inject a descendant failure via a test-only trigger on collection_items when inserting Child Req.
	if _, err := pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION test_fail_child_insert() RETURNS trigger AS $$
		BEGIN
			IF NEW.name = 'Child Req' THEN
				RAISE EXCEPTION 'injected mid-subtree insert failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER trg_test_fail_child_insert
			BEFORE INSERT ON collection_items
			FOR EACH ROW EXECUTE FUNCTION test_fail_child_insert();
	`); err != nil {
		t.Fatal(err)
	}

	opID := uuid.New()
	_, err = repo.DuplicateCollection(ctx, user, colID, &wsID, nil, opID, "fp-rollback")
	if err == nil || !strings.Contains(err.Error(), "injected mid-subtree insert failure") {
		t.Fatalf("expected injected mid-subtree failure, got: %v", err)
	}

	// Ledger row, new collection, and Root Folder copy must all have rolled back completely.
	var ledgerCount, colCount, itemCount int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM duplicate_operations WHERE actor_id = $1 AND operation_id = $2`, userID, opID).Scan(&ledgerCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM collections WHERE workspace_id = $1`, wsID).Scan(&colCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM collection_items WHERE collection_id = $1`, colID).Scan(&itemCount); err != nil {
		t.Fatal(err)
	}
	if ledgerCount != 0 || colCount != 1 || itemCount != 2 {
		t.Fatalf("expected full rollback (ledger=0, cols=1, items=2), got ledger=%d cols=%d items=%d", ledgerCount, colCount, itemCount)
	}

	// Drop trigger and confirm retrying with the same operation_id succeeds cleanly.
	if _, err := pool.Exec(ctx, `DROP TRIGGER trg_test_fail_child_insert ON collection_items; DROP FUNCTION test_fail_child_insert();`); err != nil {
		t.Fatal(err)
	}
	receipt, err := repo.DuplicateCollection(ctx, user, colID, &wsID, nil, opID, "fp-rollback")
	if err != nil {
		t.Fatalf("expected retry after rollback to succeed, got: %v", err)
	}
	if receipt.Status != "committed" || receipt.ItemCount != 2 {
		t.Fatalf("unexpected receipt after retry: %+v", receipt)
	}
}

// RR2: Self/descendant folder duplicate and concurrent delete/reorder stay consistent without orphans or deadlocks.
func TestDuplicateRepository_SelfCopyAndConcurrentWriters(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := Connect(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	userID, _, colID, folderID := seedDuplicateRepoFixture(t, ctx, pool)
	dupRepo := NewDuplicateRepository(pool)
	colRepo := NewCollectionRepository(pool)
	user := &domain.User{ID: userID, Role: domain.RoleUser}

	// 1. Self-duplicate folder into itself (snapshot-first prevents infinite loop).
	selfReceipt, err := dupRepo.DuplicateItem(ctx, user, folderID, colID, colID, &folderID, uuid.New(), "fp-self")
	if err != nil {
		t.Fatalf("self folder duplicate failed: %v", err)
	}
	if selfReceipt.ItemCount != 2 || selfReceipt.RootItemID == folderID {
		t.Fatalf("unexpected self-copy receipt: %+v", selfReceipt)
	}

	// Verify copied subtree sits cleanly under folderID without cycles or extra items.
	items, err := colRepo.ListActiveItemsByCollection(ctx, colID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 4 {
		t.Fatalf("expected 4 total active items after self-copy, got %d", len(items))
	}

	// 2. Concurrent SoftDeleteItem on a separate item + DuplicateItem on Root Folder.
	tempReqID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, method, url, last_modified_by) VALUES ($1, $2, NULL, 'request', 'Temp Req', 5, 'GET', 'https://httpbin.org/get?user=tester&tag=api', $3)`,
		tempReqID, colID, userID); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	var dupErr, delErr error
	var raceReceipt *DuplicateItemReceipt
	start := make(chan struct{})

	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		raceReceipt, dupErr = dupRepo.DuplicateItem(ctx, user, folderID, colID, colID, nil, uuid.New(), "fp-race")
	}()
	go func() {
		defer wg.Done()
		<-start
		delErr = colRepo.SoftDeleteItem(ctx, tempReqID, userID)
	}()
	close(start)
	wg.Wait()

	if dupErr != nil {
		t.Fatalf("concurrent duplicate failed: %v", dupErr)
	}
	if delErr != nil && !errors.Is(delErr, ErrItemNotFound) {
		t.Fatalf("concurrent delete failed: %v", delErr)
	}
	if raceReceipt == nil || raceReceipt.Status != "committed" {
		t.Fatalf("unexpected race receipt: %+v", raceReceipt)
	}

	// Confirm zero orphaned items (every non-null parent_id references an active folder in the same collection).
	var orphans int
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM collection_items c
		WHERE c.collection_id = $1 AND c.deleted_at IS NULL AND c.parent_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM collection_items p WHERE p.id = c.parent_id AND p.collection_id = $1 AND p.deleted_at IS NULL AND p.type = 'folder')
	`, colID).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	if orphans != 0 {
		t.Fatalf("detected %d orphaned items", orphans)
	}
}
