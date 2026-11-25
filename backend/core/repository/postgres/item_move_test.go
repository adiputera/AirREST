package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

func TestExceedsItemMoveDepth(t *testing.T) {
	if exceedsItemMoveDepth(0, 32) {
		t.Fatal("depth 32 at root must be allowed")
	}
	if exceedsItemMoveDepth(31, 1) {
		t.Fatal("combined depth 32 must be allowed")
	}
	if !exceedsItemMoveDepth(32, 1) {
		t.Fatal("combined depth 33 must be rejected")
	}
	if !exceedsItemMoveDepth(20, 13) {
		t.Fatal("combined depth 33 across subtree must be rejected")
	}
}

func TestMoveItem_RejectsDepthExceedingMax(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := Connect(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	userID := uuid.New()
	wsID := uuid.New()
	colID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, 'hash', 'Tester', 'user')`,
		userID, "move-depth-"+userID.String()+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO workspaces (id, owner_id, name, is_default) VALUES ($1, $2, 'WS', TRUE)`, wsID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collections (id, workspace_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Col', 'reader', 1, $3, $3)`,
		colID, wsID, userID); err != nil {
		t.Fatal(err)
	}

	// Build a 31-level deep folder chain as target parent
	var parentID *uuid.UUID
	for i := 0; i < 31; i++ {
		fid := uuid.New()
		if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, last_modified_by) VALUES ($1, $2, $3, 'folder', 'F', 0, $4)`,
			fid, colID, parentID, userID); err != nil {
			t.Fatal(err)
		}
		parentID = &fid
	}

	// Build a 2-level subtree (folder -> child request) so 31 + 2 = 33 > 32
	srcFolderID := uuid.New()
	srcChildID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, last_modified_by) VALUES ($1, $2, NULL, 'folder', 'Src', 1, $3)`,
		srcFolderID, colID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, method, url, last_modified_by) VALUES ($1, $2, $3, 'request', 'Req', 0, 'GET', 'https://example.com', $4)`,
		srcChildID, colID, srcFolderID, userID); err != nil {
		t.Fatal(err)
	}

	repo := NewCollectionRepository(pool)
	col := &domain.Collection{ID: colID, WorkspaceID: &wsID, MinRole: domain.ProjectRoleReader}
	err = repo.MoveItem(ctx, srcFolderID, col, col, parentID, userID)
	if !errors.Is(err, ErrInvalidItemMove) {
		t.Fatalf("expected ErrInvalidItemMove when combined depth > 32, got: %v", err)
	}
}
