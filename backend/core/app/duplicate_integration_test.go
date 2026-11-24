package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func setupDuplicateAppTest(t *testing.T, maxConns string) (*App, *token.TokenManager, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("AIRREST_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set AIRREST_TEST_DATABASE_URL to a disposable local PostgreSQL database ending in _test")
	}
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || !strings.HasSuffix(u.Path, "_test") {
		t.Fatal("integration tests require a disposable localhost database ending in _test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)

	control, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "dupapp_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := control.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		control.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := control.Exec(cleanupCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		control.Close()
	})

	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	t.Setenv("DATABASE_URL", u.String())
	const jwtKey = "c72f384ab68ed95f20813ac4697e5db0a4629e31bf50867c1d8ab73946f205ee"
	t.Setenv("JWT_SECRET", jwtKey)
	t.Setenv("DB_MAX_CONNS", maxConns)
	t.Setenv("DB_MIN_CONNS", "0")
	t.Setenv("SKIP_MIGRATIONS", "false")
	t.Setenv("SUPERADMIN_EMAIL", "superadmin@example.com")
	t.Setenv("SUPERADMIN_PASSWORD", "test-bootstrap-"+uuid.NewString())

	a, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	tm := token.NewTokenManager(jwtKey, 1, 7)
	return a, tm, ctx
}

func doJSONRequest(t *testing.T, router http.Handler, method, path, bearer string, body any, gzipBody bool) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		if gzipBody {
			gw := gzip.NewWriter(&buf)
			if _, err := gw.Write(raw); err != nil {
				t.Fatal(err)
			}
			if err := gw.Close(); err != nil {
				t.Fatal(err)
			}
		} else {
			buf.Write(raw)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if gzipBody {
		req.Header.Set("Content-Encoding", "gzip")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func decodeEnvelope[T any](t *testing.T, rr *httptest.ResponseRecorder) (bool, string, string, T) {
	t.Helper()
	var env struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
		Code    string `json:"code"`
		Data    T      `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &env); err != nil {
		t.Fatalf("failed to decode envelope (%d): %v | body=%s", rr.Code, err, rr.Body.String())
	}
	return env.Success, env.Error, env.Code, env.Data
}

func TestDuplicateIntegration_EndToEndMatrixRBACIdempotencyAndLimits(t *testing.T) {
	// Use DB_MAX_CONNS=1 to prove every query inside duplicate runs on the single tx connection (RR1).
	a, tm, ctx := setupDuplicateAppTest(t, "1")

	userRepo := postgres.NewUserRepository(a.Pool)
	wsRepo := postgres.NewWorkspaceRepository(a.Pool)
	teamRepo := postgres.NewTeamRepository(a.Pool)
	projRepo := postgres.NewProjectRepository(a.Pool)

	createUser := func(email string) (*domain.User, uuid.UUID, string) {
		u := &domain.User{Email: email, PasswordHash: "hash", Name: email, Role: domain.RoleUser}
		if err := userRepo.Create(ctx, u); err != nil {
			t.Fatal(err)
		}
		ws := &domain.Workspace{OwnerID: u.ID, Name: "Personal " + email, IsDefault: true}
		if err := wsRepo.Create(ctx, ws); err != nil {
			t.Fatal(err)
		}
		tok, _, err := tm.GenerateToken(u.ID, u.Email, string(u.Role), u.TokenVersion)
		if err != nil {
			t.Fatal(err)
		}
		return u, ws.ID, tok
	}

	alice, aliceWs1, aliceTok := createUser("alice@example.com")
	bob, bobWs, bobTok := createUser("bob@example.com")

	aliceWs2 := &domain.Workspace{OwnerID: alice.ID, Name: "Personal 2"}
	if err := wsRepo.Create(ctx, aliceWs2); err != nil {
		t.Fatal(err)
	}

	// Teams and projects (Team1 has ProjA & ProjB; Team2 has ProjC for cross-team project->project test).
	team1 := &domain.Team{Name: "Team 1", CreatedBy: alice.ID}
	team2 := &domain.Team{Name: "Team 2", CreatedBy: alice.ID}
	if err := teamRepo.Create(ctx, team1); err != nil {
		t.Fatal(err)
	}
	if err := teamRepo.Create(ctx, team2); err != nil {
		t.Fatal(err)
	}
	for _, tmMember := range []struct {
		teamID uuid.UUID
		userID uuid.UUID
	}{
		{team1.ID, alice.ID},
		{team1.ID, bob.ID},
		{team2.ID, alice.ID},
	} {
		if err := teamRepo.AddMember(ctx, &domain.TeamMember{TeamID: tmMember.teamID, UserID: tmMember.userID, Role: domain.TeamRoleMember}); err != nil {
			t.Fatal(err)
		}
	}

	projA := &domain.Project{TeamID: team1.ID, Name: "Proj A", CreatedBy: alice.ID}
	projB := &domain.Project{TeamID: team1.ID, Name: "Proj B", CreatedBy: alice.ID}
	projC := &domain.Project{TeamID: team2.ID, Name: "Proj C", CreatedBy: alice.ID}
	for _, p := range []*domain.Project{projA, projB, projC} {
		if err := projRepo.Create(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	// Alice: admin in ProjA, contributor in ProjB, contributor in ProjC. Bob: reader in ProjA, contributor in ProjB.
	for _, pm := range []*domain.ProjectMember{
		{ProjectID: projA.ID, UserID: alice.ID, Role: domain.ProjectRoleAdmin},
		{ProjectID: projB.ID, UserID: alice.ID, Role: domain.ProjectRoleContributor},
		{ProjectID: projC.ID, UserID: alice.ID, Role: domain.ProjectRoleContributor},
		{ProjectID: projA.ID, UserID: bob.ID, Role: domain.ProjectRoleReader},
		{ProjectID: projB.ID, UserID: bob.ID, Role: domain.ProjectRoleContributor},
	} {
		if err := projRepo.AddMember(ctx, pm); err != nil {
			t.Fatal(err)
		}
	}

	// Disable collection.move feature policy to verify Duplicate is NOT blocked by collection.move (B02).
	if _, err := a.Pool.Exec(ctx, `UPDATE feature_policies SET collection_move_enabled = FALSE, revision = revision + 1 WHERE singleton = TRUE`); err != nil {
		t.Fatal(err)
	}

	// B01 + RR6: Offline -> Personal Cloud via gzipped import-duplicate with path_variables & form-data metadata.
	importOpID := uuid.New()
	importPayload := map[string]any{
		"operation_id":        importOpID.String(),
		"target_workspace_id": aliceWs1.String(),
		"collection": map[string]any{
			"name":        "Product APIs",
			"description": "Offline uploaded",
			"items": []any{
				map[string]any{
					"type":       "folder",
					"name":       "Users",
					"sort_order": 0,
					"items": []any{
						map[string]any{
							"type":           "request",
							"name":           "Upload Avatar",
							"sort_order":     0,
							"method":         "POST",
							"url":            "https://httpbin.org/get?user=tester&tag=api",
							"params":         []any{map[string]any{"id": "p1", "key": "tag", "value": "api", "enabled": false}},
							"path_variables": []any{map[string]any{"id": "pv1", "key": "id", "value": "42", "enabled": true}},
							"headers":        []any{map[string]any{"id": "h1", "key": "X-Test", "value": "1", "enabled": false}},
							"auth":           map[string]any{"type": "bearer", "bearerToken": "dummy-token"},
							"body_type":      "form-data",
							"body_form_data": []any{map[string]any{
								"id": "fd1", "key": "file", "type": "file", "value": "avatar.png",
								"fileName": "avatar.png", "fileSize": 1024, "fileType": "image/png", "needsReselection": true, "enabled": true,
							}},
						},
					},
				},
			},
		},
	}
	rrImport := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/import-duplicate", aliceTok, importPayload, true)
	if rrImport.Code != http.StatusCreated {
		t.Fatalf("expected 201 on import-duplicate, got %d (%s)", rrImport.Code, rrImport.Body.String())
	}
	_, _, _, importReceipt := decodeEnvelope[postgres.DuplicateCollectionReceipt](t, rrImport)
	if importReceipt.Status != "committed" || importReceipt.Name != "Product APIs" || importReceipt.ItemCount != 2 || importReceipt.MinRole != domain.ProjectRoleReader {
		t.Fatalf("unexpected import receipt: %+v", importReceipt)
	}

	// Replay import-duplicate with same operation_id (lost response recovery): must return same collection_id without creating a second copy.
	rrImportReplay := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/import-duplicate", aliceTok, importPayload, false)
	if rrImportReplay.Code != http.StatusCreated {
		t.Fatalf("expected 201 on import replay, got %d (%s)", rrImportReplay.Code, rrImportReplay.Body.String())
	}
	_, _, _, replayReceipt := decodeEnvelope[postgres.DuplicateCollectionReceipt](t, rrImportReplay)
	if replayReceipt.CollectionID != importReceipt.CollectionID {
		t.Fatalf("replay created different collection: %s vs %s", replayReceipt.CollectionID, importReceipt.CollectionID)
	}

	// Replay with same operation_id but different payload -> 409 Conflict.
	importPayloadMismatch := map[string]any{
		"operation_id":        importOpID.String(),
		"target_workspace_id": aliceWs1.String(),
		"collection":          map[string]any{"name": "Different Name", "items": []any{}},
	}
	rrMismatch := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/import-duplicate", aliceTok, importPayloadMismatch, false)
	if rrMismatch.Code != http.StatusConflict {
		t.Fatalf("expected 409 on operation_id fingerprint mismatch, got %d (%s)", rrMismatch.Code, rrMismatch.Body.String())
	}

	// Verify GET detail preserves form-data metadata & path_variables.
	rrGetCol := doJSONRequest(t, a.Router, http.MethodGet, "/api/v1/collections/"+importReceipt.CollectionID.String(), aliceTok, nil, false)
	if rrGetCol.Code != http.StatusOK {
		t.Fatalf("expected 200 GET collection, got %d", rrGetCol.Code)
	}
	_, _, _, fetchedCol := decodeEnvelope[domain.Collection](t, rrGetCol)
	if len(fetchedCol.Items) != 2 {
		t.Fatalf("expected 2 items in imported collection, got %d", len(fetchedCol.Items))
	}
	var rootFolderID, reqItemID uuid.UUID
	for _, it := range fetchedCol.Items {
		if it.Type == domain.ItemTypeFolder {
			rootFolderID = it.ID
		} else {
			reqItemID = it.ID
			if it.BodyFormData == nil || !strings.Contains(string(*it.BodyFormData), `"needsReselection":true`) || !strings.Contains(string(*it.BodyFormData), `"fileSize":1024`) {
				t.Fatalf("form-data metadata lost in persistence: %v", it.BodyFormData)
			}
		}
	}

	// B01: Personal -> Personal same workspace gets " copy", different workspace keeps name.
	rrSameWs := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+importReceipt.CollectionID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":        uuid.NewString(),
		"target_workspace_id": aliceWs1.String(),
	}, false)
	if rrSameWs.Code != http.StatusCreated {
		t.Fatalf("expected 201 same ws duplicate, got %d (%s)", rrSameWs.Code, rrSameWs.Body.String())
	}
	_, _, _, sameWsReceipt := decodeEnvelope[postgres.DuplicateCollectionReceipt](t, rrSameWs)
	if sameWsReceipt.Name != "Product APIs copy" || sameWsReceipt.CollectionID == importReceipt.CollectionID {
		t.Fatalf("unexpected same-ws receipt: %+v", sameWsReceipt)
	}

	// Personal -> Project (Alice is contributor in ProjB).
	rrPersToProj := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+importReceipt.CollectionID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":      uuid.NewString(),
		"target_project_id": projB.ID.String(),
	}, false)
	if rrPersToProj.Code != http.StatusCreated {
		t.Fatalf("expected 201 personal->project, got %d (%s)", rrPersToProj.Code, rrPersToProj.Body.String())
	}

	// Create admin-min_role collection in ProjA (Alice is admin in ProjA, contributor in ProjC across teams).
	projAColID := uuid.New()
	if _, err := a.Pool.Exec(ctx, `INSERT INTO collections (id, project_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Admin Secret', 'admin', 1, $3, $3)`,
		projAColID, projA.ID, alice.ID); err != nil {
		t.Fatal(err)
	}

	// B02 + B07: Project A (admin min_role) -> Project C (different team, Alice contributor) clamps min_role to contributor!
	rrCrossTeam := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+projAColID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":      uuid.NewString(),
		"target_project_id": projC.ID.String(),
	}, false)
	if rrCrossTeam.Code != http.StatusCreated {
		t.Fatalf("expected 201 cross-team project->project with min_role clamp, got %d (%s)", rrCrossTeam.Code, rrCrossTeam.Body.String())
	}
	_, _, _, crossTeamReceipt := decodeEnvelope[postgres.DuplicateCollectionReceipt](t, rrCrossTeam)
	if crossTeamReceipt.MinRole != domain.ProjectRoleContributor || crossTeamReceipt.Name != "Admin Secret" {
		t.Fatalf("expected clamped min_role=contributor and preserved name, got %+v", crossTeamReceipt)
	}
	// Verify Alice (contributor in ProjC) can list and read her clamped collection (no self-lockout).
	rrListProjC := doJSONRequest(t, a.Router, http.MethodGet, "/api/v1/collections?project_id="+projC.ID.String(), aliceTok, nil, false)
	if rrListProjC.Code != http.StatusOK {
		t.Fatalf("expected 200 listing ProjC, got %d", rrListProjC.Code)
	}
	_, _, _, projCCols := decodeEnvelope[[]domain.Collection](t, rrListProjC)
	if len(projCCols) != 1 || projCCols[0].ID != crossTeamReceipt.CollectionID {
		t.Fatalf("expected clamped collection visible in ProjC, got %+v", projCCols)
	}

	// B02: Project -> Personal MUST be rejected 403!
	rrProjToPersonal := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+projAColID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":        uuid.NewString(),
		"target_workspace_id": aliceWs1.String(),
	}, false)
	if rrProjToPersonal.Code != http.StatusForbidden {
		t.Fatalf("expected 403 project->personal, got %d (%s)", rrProjToPersonal.Code, rrProjToPersonal.Body.String())
	}

	// B02: Bob is reader in ProjA and contributor in ProjB -> reader on source MUST be rejected 403!
	projAReaderColID := uuid.New()
	if _, err := a.Pool.Exec(ctx, `INSERT INTO collections (id, project_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Reader Visible', 'reader', 1, $3, $3)`,
		projAReaderColID, projA.ID, alice.ID); err != nil {
		t.Fatal(err)
	}
	rrBobReadSource := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+projAReaderColID.String()+"/duplicate", bobTok, map[string]any{
		"operation_id":      uuid.NewString(),
		"target_project_id": projB.ID.String(),
	}, false)
	if rrBobReadSource.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when actor lacks write on source, got %d", rrBobReadSource.Code)
	}
	// Bob lacks write on target ProjA even though he owns bobWs -> rejected 403!
	rrBobToWs := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+importReceipt.CollectionID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":        uuid.NewString(),
		"target_workspace_id": bobWs.String(),
	}, false)
	if rrBobToWs.Code != http.StatusForbidden {
		t.Fatalf("expected 403 writing to another user's workspace, got %d", rrBobToWs.Code)
	}

	// B01 + B07: Item duplicate into target_parent_id folder (different collection in same workspace).
	targetCol2ID := sameWsReceipt.CollectionID
	rrCol2 := doJSONRequest(t, a.Router, http.MethodGet, "/api/v1/collections/"+targetCol2ID.String(), aliceTok, nil, false)
	_, _, _, targetCol2 := decodeEnvelope[domain.Collection](t, rrCol2)
	var col2FolderID uuid.UUID
	for _, it := range targetCol2.Items {
		if it.Type == domain.ItemTypeFolder {
			col2FolderID = it.ID
		}
	}

	itemDupOpID := uuid.New()
	rrItemDup := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/items/"+reqItemID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":         itemDupOpID.String(),
		"source_collection_id": importReceipt.CollectionID.String(),
		"target_collection_id": targetCol2ID.String(),
		"target_parent_id":     col2FolderID.String(),
	}, false)
	if rrItemDup.Code != http.StatusCreated {
		t.Fatalf("expected 201 item duplicate into folder, got %d (%s)", rrItemDup.Code, rrItemDup.Body.String())
	}
	_, _, _, itemReceipt := decodeEnvelope[postgres.DuplicateItemReceipt](t, rrItemDup)
	if itemReceipt.Name != "Upload Avatar" || itemReceipt.TargetParentID == nil || *itemReceipt.TargetParentID != col2FolderID {
		t.Fatalf("unexpected item duplicate receipt: %+v", itemReceipt)
	}

	// B03: target_parent_id pointing to a request (non-folder) or item in wrong collection -> 400.
	rrBadParent := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/items/"+reqItemID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":         uuid.NewString(),
		"source_collection_id": importReceipt.CollectionID.String(),
		"target_collection_id": targetCol2ID.String(),
		"target_parent_id":     reqItemID.String(),
	}, false)
	if rrBadParent.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-folder/cross-col target_parent_id, got %d", rrBadParent.Code)
	}

	// B06 / RR4: Replay after item is deleted in another session returns committed_deleted and does NOT resurrect it!
	rrDelItem := doJSONRequest(t, a.Router, http.MethodDelete, "/api/v1/items/"+itemReceipt.RootItemID.String(), aliceTok, nil, false)
	if rrDelItem.Code != http.StatusOK {
		t.Fatalf("expected 200 deleting copied item, got %d", rrDelItem.Code)
	}
	// Simulate ledger TTL snapshot expiry on that operation row too!
	if _, err := a.Pool.Exec(ctx, `UPDATE duplicate_operations SET status = 'expired' WHERE actor_id = $1 AND operation_id = $2`, alice.ID, itemDupOpID); err != nil {
		t.Fatal(err)
	}
	rrReplayDeleted := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/items/"+reqItemID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":         itemDupOpID.String(),
		"source_collection_id": importReceipt.CollectionID.String(),
		"target_collection_id": targetCol2ID.String(),
		"target_parent_id":     col2FolderID.String(),
	}, false)
	if rrReplayDeleted.Code != http.StatusCreated {
		t.Fatalf("expected 201 receipt for deleted replay, got %d (%s)", rrReplayDeleted.Code, rrReplayDeleted.Body.String())
	}
	_, _, _, deletedReceipt := decodeEnvelope[postgres.DuplicateItemReceipt](t, rrReplayDeleted)
	if deletedReceipt.Status != "committed_deleted" {
		t.Fatalf("expected committed_deleted status without resurrection, got %+v", deletedReceipt)
	}

	// B08: PullDelta includes duplicated items with zero tombstones from source.
	rrDelta := doJSONRequest(t, a.Router, http.MethodGet, "/api/v1/sync/pull?workspace_id="+aliceWs1.String(), aliceTok, nil, false)
	if rrDelta.Code != http.StatusOK {
		t.Fatalf("expected 200 delta pull, got %d", rrDelta.Code)
	}
	_, _, _, delta := decodeEnvelope[service.SyncDeltaResult](t, rrDelta)
	if len(delta.Collections) < 2 || len(delta.Items) < 4 {
		t.Fatalf("expected duplicated collections & items in delta pull, got cols=%d items=%d", len(delta.Collections), len(delta.Items))
	}

	// B09: Combined depth 32 vs 33 check on item duplicate.
	// Build a 31-level nested folder chain in importReceipt.CollectionID (so deepest folder is at depth 31).
	var parentPtr = &rootFolderID // already at depth 1
	for d := 2; d <= 31; d++ {
		fid := uuid.New()
		if _, err := a.Pool.Exec(ctx, `INSERT INTO collection_items (id, collection_id, parent_id, type, name, sort_order, last_modified_by) VALUES ($1, $2, $3, 'folder', $4, 0, $5)`,
			fid, importReceipt.CollectionID, parentPtr, fmt.Sprintf("D%d", d), alice.ID); err != nil {
			t.Fatal(err)
		}
		parentPtr = &fid
	}
	// Duplicating a single request (depth 1) into depth-31 folder -> total depth 32 -> succeeds!
	rrDepth32 := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/items/"+reqItemID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":         uuid.NewString(),
		"source_collection_id": importReceipt.CollectionID.String(),
		"target_collection_id": importReceipt.CollectionID.String(),
		"target_parent_id":     parentPtr.String(),
	}, false)
	if rrDepth32.Code != http.StatusCreated {
		t.Fatalf("expected 201 for combined depth 32, got %d (%s)", rrDepth32.Code, rrDepth32.Body.String())
	}
	// Duplicating a folder containing a child (depth 2) into depth-31 folder -> total depth 33 -> 413!
	rrDepth33 := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/items/"+rootFolderID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":         uuid.NewString(),
		"source_collection_id": importReceipt.CollectionID.String(),
		"target_collection_id": importReceipt.CollectionID.String(),
		"target_parent_id":     parentPtr.String(),
	}, false)
	if rrDepth33.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for combined depth 33, got %d (%s)", rrDepth33.Code, rrDepth33.Body.String())
	}

	// B09 / RR8: Request > 4 MiB on standard duplicate route or > 16 MiB decoded on import-duplicate rejected 413 before write.
	hugeBody := strings.Repeat("a", int(middleware.MaxRequestBytes)+1024)
	rrHuge := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+importReceipt.CollectionID.String()+"/duplicate", aliceTok, map[string]any{
		"operation_id":        uuid.NewString(),
		"target_workspace_id": hugeBody,
	}, false)
	if rrHuge.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized duplicate body, got %d", rrHuge.Code)
	}
}

// B05 / B06 / RR1: Concurrent parallel replay & concurrent role revocation under real multi-connection pool.
func TestDuplicateIntegration_ConcurrentReplayAndRoleRevoke(t *testing.T) {
	a, tm, ctx := setupDuplicateAppTest(t, "8")

	userRepo := postgres.NewUserRepository(a.Pool)
	teamRepo := postgres.NewTeamRepository(a.Pool)
	projRepo := postgres.NewProjectRepository(a.Pool)

	owner := &domain.User{Email: "owner-race@example.com", PasswordHash: "hash", Name: "Owner", Role: domain.RoleUser}
	if err := userRepo.Create(ctx, owner); err != nil {
		t.Fatal(err)
	}
	member := &domain.User{Email: "member-race@example.com", PasswordHash: "hash", Name: "Member", Role: domain.RoleUser}
	if err := userRepo.Create(ctx, member); err != nil {
		t.Fatal(err)
	}
	memberTok, _, err := tm.GenerateToken(member.ID, member.Email, string(member.Role), member.TokenVersion)
	if err != nil {
		t.Fatal(err)
	}

	team := &domain.Team{Name: "Race Team", CreatedBy: owner.ID}
	if err := teamRepo.Create(ctx, team); err != nil {
		t.Fatal(err)
	}
	_ = teamRepo.AddMember(ctx, &domain.TeamMember{TeamID: team.ID, UserID: member.ID, Role: domain.TeamRoleMember})
	proj := &domain.Project{TeamID: team.ID, Name: "Race Proj", CreatedBy: owner.ID}
	if err := projRepo.Create(ctx, proj); err != nil {
		t.Fatal(err)
	}
	_ = projRepo.AddMember(ctx, &domain.ProjectMember{ProjectID: proj.ID, UserID: member.ID, Role: domain.ProjectRoleContributor})

	colID := uuid.New()
	if _, err := a.Pool.Exec(ctx, `INSERT INTO collections (id, project_id, name, min_role, version, created_by, last_modified_by) VALUES ($1, $2, 'Race Col', 'reader', 1, $3, $3)`,
		colID, proj.ID, owner.ID); err != nil {
		t.Fatal(err)
	}

	// 1. Concurrent parallel replay of the exact same operation_id produces exactly 1 copy.
	opID := uuid.New()
	var wg sync.WaitGroup
	codes := make([]int, 4)
	colIDs := make([]uuid.UUID, 4)
	start := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			rr := doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+colID.String()+"/duplicate", memberTok, map[string]any{
				"operation_id":      opID.String(),
				"target_project_id": proj.ID.String(),
			}, false)
			codes[idx] = rr.Code
			if rr.Code == http.StatusCreated {
				_, _, _, rec := decodeEnvelope[postgres.DuplicateCollectionReceipt](t, rr)
				colIDs[idx] = rec.CollectionID
			}
		}(i)
	}
	close(start)
	wg.Wait()

	var totalCols int
	if err := a.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM collections WHERE project_id = $1`, proj.ID).Scan(&totalCols); err != nil {
		t.Fatal(err)
	}
	if totalCols != 2 {
		t.Fatalf("expected exactly 2 collections (1 source + 1 copy) after 4 parallel replays, got %d (codes=%v)", totalCols, codes)
	}
	for i := 0; i < 4; i++ {
		if codes[i] != http.StatusCreated || colIDs[i] != colIDs[0] {
			t.Fatalf("parallel replay %d mismatch: code=%d id=%s vs %s", i, codes[i], colIDs[i], colIDs[0])
		}
	}

	// 2. Real transaction barrier test: hold FOR UPDATE on project_members downgrading member to reader,
	// fire DuplicateCollection, release downgrade commit -> Duplicate must be serialized AFTER downgrade and return 403!
	barrierTx, err := a.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := barrierTx.Exec(ctx, `UPDATE project_members SET role = 'reader' WHERE project_id = $1 AND user_id = $2`, proj.ID, member.ID); err != nil {
		_ = barrierTx.Rollback(ctx)
		t.Fatal(err)
	}

	var revokeResp *httptest.ResponseRecorder
	done := make(chan struct{})
	go func() {
		defer close(done)
		revokeResp = doJSONRequest(t, a.Router, http.MethodPost, "/api/v1/collections/"+colID.String()+"/duplicate", memberTok, map[string]any{
			"operation_id":      uuid.NewString(),
			"target_project_id": proj.ID.String(),
		}, false)
	}()

	time.Sleep(150 * time.Millisecond)
	if err := barrierTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	<-done

	if revokeResp.Code != http.StatusForbidden {
		t.Fatalf("expected 403 after serialized role downgrade to reader, got %d (%s)", revokeResp.Code, revokeResp.Body.String())
	}
}
