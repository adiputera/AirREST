package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This suite requires an explicitly supplied disposable local database ending in
// _test. Every run creates and removes its own schema; it never uses app data.
func TestSecurityIntegration(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	control, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	schema := "audit_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := control.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := control.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	t.Setenv("DATABASE_URL", u.String())
	const key = "c72f384ab68ed95f20813ac4697e5db0a4629e31bf50867c1d8ab73946f205ee"
	t.Setenv("JWT_SECRET", key)
	t.Setenv("DB_MAX_CONNS", "1")
	t.Setenv("DB_MIN_CONNS", "0")
	t.Setenv("SKIP_MIGRATIONS", "false")
	t.Setenv("SUPERADMIN_EMAIL", "")
	t.Setenv("SUPERADMIN_PASSWORD", "")
	if a, err := New(ctx); err == nil {
		a.Pool.Close()
		t.Fatal("startup accepted missing bootstrap credentials")
	}
	t.Setenv("SUPERADMIN_EMAIL", "admin@example.com")
	t.Setenv("SUPERADMIN_PASSWORD", "SuperadminSecurePassword123!")
	if a, err := New(ctx); err == nil {
		a.Pool.Close()
		t.Fatal("startup accepted example bootstrap password")
	}
	t.Setenv("SUPERADMIN_PASSWORD", "test-bootstrap-"+uuid.NewString())
	a, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Pool.Close()
	t.Setenv("SUPERADMIN_EMAIL", "")
	t.Setenv("SUPERADMIN_PASSWORD", "")
	existing, err := New(ctx)
	if err != nil {
		t.Fatalf("existing admin should not require bootstrap credentials: %v", err)
	}
	existing.Pool.Close()

	users := postgres.NewUserRepository(a.Pool)
	tm := token.NewTokenManager(key, 1)
	auth := service.NewAuthService(users, tm)
	teams := postgres.NewTeamRepository(a.Pool)
	projects := postgres.NewProjectRepository(a.Pool)
	projectService := service.NewProjectService(projects, teams, service.NewTeamService(teams, users))
	collections := service.NewCollectionService(postgres.NewCollectionRepository(a.Pool), postgres.NewWorkspaceRepository(a.Pool), projects, projectService)
	environments := service.NewEnvironmentService(postgres.NewEnvironmentRepository(a.Pool), collections, projectService)
	syncService := service.NewSyncService(a.Pool, collections, environments)
	admin, err := users.GetByEmail(ctx, "admin@example.com")
	if err != nil {
		t.Fatal(err)
	}
	newUser := func(name string) (*domain.User, *service.TokenPair) {
		t.Helper()
		user, err := auth.CreateUserByAdmin(ctx, name+"@example.com", "initial-test-password", name, domain.RoleUser)
		if err != nil {
			t.Fatal(err)
		}
		_, pair, err := auth.Login(ctx, user.Email, "initial-test-password")
		if err != nil {
			t.Fatal(err)
		}
		return user, pair
	}
	request := func(method, path, access string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var data []byte
		if body != nil {
			var err error
			data, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(data)).WithContext(ctx)
		if access != "" {
			req.Header.Set("Authorization", "Bearer "+access)
		}
		w := httptest.NewRecorder()
		a.Router.ServeHTTP(w, req)
		return w
	}
	assertStatus := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("wanted HTTP %d, got %d: %s", status, w.Code, w.Body)
		}
	}

	t.Run("password resets and changes revoke access and refresh", func(t *testing.T) {
		if err := auth.ResetPasswordByAdmin(ctx, uuid.New(), "admin-reset-password"); !errors.Is(err, postgres.ErrUserNotFound) {
			t.Fatalf("nonexistent reset: %v", err)
		}
		user, pair := newUser("sessions")
		assertStatus(request("GET", "/api/v1/auth/me", pair.AccessToken, nil), 200)
		if _, err := auth.UpdateProfile(ctx, user.ID, "Renamed", nil); err != nil {
			t.Fatal(err)
		}
		assertStatus(request("GET", "/api/v1/auth/me", pair.AccessToken, nil), 200)
		if _, _, err := auth.RefreshToken(ctx, pair.RefreshToken); err != nil {
			t.Fatal("profile update revoked session")
		}
		if err := auth.ResetPasswordByAdmin(ctx, user.ID, "admin-reset-password"); err != nil {
			t.Fatal(err)
		}
		assertStatus(request("GET", "/api/v1/auth/me", pair.AccessToken, nil), 401)
		assertStatus(request("POST", "/api/v1/auth/refresh", "", map[string]string{"refresh_token": pair.RefreshToken}), 401)
		_, fresh, err := auth.Login(ctx, user.Email, "admin-reset-password")
		if err != nil {
			t.Fatal(err)
		}
		changed := request("PUT", "/api/v1/auth/password", fresh.AccessToken, map[string]string{"current_password": "admin-reset-password", "new_password": "self-changed-password"})
		assertStatus(changed, 200)
		var changedResponse struct {
			Data struct {
				Token        string `json:"token"`
				RefreshToken string `json:"refresh_token"`
			} `json:"data"`
		}
		if err := json.NewDecoder(changed.Body).Decode(&changedResponse); err != nil {
			t.Fatal(err)
		}
		if changedResponse.Data.Token == "" || changedResponse.Data.RefreshToken == "" {
			t.Fatal("password change did not return a replacement token pair")
		}
		assertStatus(request("GET", "/api/v1/auth/me", fresh.AccessToken, nil), 401)
		assertStatus(request("POST", "/api/v1/auth/refresh", "", map[string]string{"refresh_token": fresh.RefreshToken}), 401)
		assertStatus(request("GET", "/api/v1/auth/me", changedResponse.Data.Token, nil), 200)
		assertStatus(request("POST", "/api/v1/auth/refresh", "", map[string]string{"refresh_token": changedResponse.Data.RefreshToken}), 200)
		// Old credential snapshots must not overwrite a reset or issue a valid session.
		if err := users.UpdatePassword(ctx, user.ID, user.PasswordHash, &user.TokenVersion); !errors.Is(err, postgres.ErrCredentialsChanged) {
			t.Fatalf("stale update: %v", err)
		}
		stale, _, err := tm.GenerateToken(user.ID, user.Email, string(user.Role), user.TokenVersion)
		if err != nil {
			t.Fatal(err)
		}
		assertStatus(request("GET", "/api/v1/auth/me", stale, nil), 401)
		for _, kind := range []string{"access", "refresh"} {
			legacy, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"user_id": user.ID.String(), "token_type": kind, "iss": "airrest-api", "exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte(key))
			if err != nil {
				t.Fatal(err)
			}
			if kind == "access" {
				assertStatus(request("GET", "/api/v1/auth/me", legacy, nil), 401)
			} else {
				assertStatus(request("POST", "/api/v1/auth/refresh", "", map[string]string{"refresh_token": legacy}), 401)
			}
		}
	})

	contributor, contributorTokens := newUser("contributor")
	maintainer, _ := newUser("maintainer")
	reader, _ := newUser("reader")
	teamID, projectID := uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := a.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO teams (id,name,created_by) VALUES ($1,'Test team',$2)", teamID, admin.ID)
	exec("INSERT INTO projects (id,team_id,name,created_by) VALUES ($1,$2,'Test project',$3)", projectID, teamID, admin.ID)
	for _, member := range []struct {
		user *domain.User
		role string
	}{{contributor, "contributor"}, {maintainer, "maintainer"}, {reader, "reader"}} {
		exec("INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,'member')", teamID, member.user.ID)
		exec("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", projectID, member.user.ID, member.role)
	}
	workspaceID := uuid.New()
	exec("INSERT INTO workspaces (id,owner_id,name) VALUES ($1,$2,'Private')", workspaceID, contributor.ID)
	createCollection := func(name string, role domain.ProjectRole) *domain.Collection {
		t.Helper()
		col := &domain.Collection{ID: uuid.New(), Name: name, ProjectID: &projectID, MinRole: role}
		if err := collections.CreateCollection(ctx, admin, col); err != nil {
			t.Fatal(err)
		}
		return col
	}
	restricted := createCollection("Restricted", domain.ProjectRoleAdmin)
	open := createCollection("Open", domain.ProjectRoleReader)

	t.Run("imports enforce restriction and rollback preceding writes", func(t *testing.T) {
		newID := uuid.New()
		batch := []service.ImportCollectionRequest{{ID: newID.String(), Name: "Must roll back"}, {ID: restricted.ID.String(), Name: "Attempted overwrite", Items: []service.ImportItemRequest{{ID: uuid.NewString(), Name: "Injected", Type: "request"}}}}
		if err := syncService.ImportBatch(ctx, contributor, nil, &projectID, batch); !errors.Is(err, service.ErrForbidden) {
			t.Fatalf("restricted import: %v", err)
		}
		var count int
		if err := a.Pool.QueryRow(ctx, "SELECT count(*) FROM collections WHERE id=$1", newID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial write: %d %v", count, err)
		}
		col, err := collections.GetCollection(ctx, admin, restricted.ID)
		if err != nil || col.Name != "Restricted" || len(col.Items) != 0 {
			t.Fatalf("restricted data changed: %+v %v", col, err)
		}
		if err := syncService.ImportBatch(ctx, contributor, &workspaceID, &projectID, batch); !errors.Is(err, service.ErrInvalidScope) {
			t.Fatal("ambiguous scope accepted")
		}
		valid := []service.ImportCollectionRequest{{ID: open.ID.String(), Name: "Authorized", Items: []service.ImportItemRequest{{ID: uuid.NewString(), Name: "Allowed", Type: "request"}}}}
		if err := syncService.ImportBatch(ctx, contributor, nil, &projectID, valid); err != nil {
			t.Fatal(err)
		}
		if err := syncService.ImportBatch(ctx, reader, nil, &projectID, valid); !errors.Is(err, service.ErrForbidden) {
			t.Fatalf("reader import: %v", err)
		}
		// Cross-scope IDs are remapped into fresh collections, never overwritten.
		if err := syncService.ImportBatch(ctx, contributor, &workspaceID, nil, []service.ImportCollectionRequest{{ID: restricted.ID.String(), Name: "Private copy"}}); err != nil {
			t.Fatal(err)
		}
		col, err = collections.GetCollection(ctx, admin, restricted.ID)
		if err != nil || col.Name != "Restricted" {
			t.Fatal("cross-scope overwrite")
		}
		deleted := createCollection("Deleted", domain.ProjectRoleReader)
		if err := collections.DeleteCollection(ctx, admin, deleted.ID); err != nil {
			t.Fatal(err)
		}
		if err := syncService.ImportBatch(ctx, contributor, nil, &projectID, []service.ImportCollectionRequest{{ID: deleted.ID.String(), Name: "Zombie"}}); !errors.Is(err, service.ErrForbidden) {
			t.Fatalf("deleted import: %v", err)
		}
	})

	t.Run("operation permissions cover REST sync and authorized success", func(t *testing.T) {
		assertStatus(request("DELETE", "/api/v1/collections/"+open.ID.String(), contributorTokens.AccessToken, nil), 403)
		assertStatus(request("POST", "/api/v1/collections/"+open.ID.String()+"/move", contributorTokens.AccessToken, map[string]string{"target_workspace_id": workspaceID.String()}), 403)
		env := &domain.Environment{ID: uuid.New(), Name: "Environment", ProjectID: &projectID, MinRole: domain.ProjectRoleReader, Variables: new(json.RawMessage(`[]`))}
		if err := environments.Create(ctx, admin, env); err != nil {
			t.Fatal(err)
		}
		assertStatus(request("DELETE", "/api/v1/environments/"+env.ID.String(), contributorTokens.AccessToken, nil), 403)
		result, err := syncService.PushChangeset(ctx, contributor, service.SyncPushRequest{ProjectID: &projectID, Collections: []service.SyncCollectionMutation{{Action: "delete", Collection: domain.Collection{ID: open.ID}}}, Environments: []service.SyncEnvironmentMutation{{Action: "delete", Environment: domain.Environment{ID: env.ID}}}})
		if err != nil || len(result.AppliedIDs) != 0 {
			t.Fatalf("sync deletion bypass: %+v %v", result, err)
		}
		if _, err := collections.GetCollection(ctx, contributor, open.ID); err != nil {
			t.Fatal("collection deleted")
		}
		if _, err := environments.Get(ctx, contributor, env.ID); err != nil {
			t.Fatal("environment deleted")
		}
		if err := collections.DeleteCollection(ctx, maintainer, restricted.ID); err == nil {
			t.Fatal("maintainer deleted restricted collection")
		}
		if err := collections.MoveCollection(ctx, maintainer, open.ID, &workspaceID, nil); err == nil {
			t.Fatal("foreign workspace accepted")
		}
		if err := collections.MoveCollection(ctx, admin, open.ID, &workspaceID, nil); !errors.Is(err, service.ErrProjectCollectionMoveToPersonalScope) {
			t.Fatalf("project-to-personal move: %v", err)
		}
		personal := &domain.Collection{ID: uuid.New(), Name: "Personal", WorkspaceID: &workspaceID, MinRole: domain.ProjectRoleReader}
		if err := collections.CreateCollection(ctx, contributor, personal); err != nil {
			t.Fatal(err)
		}
		if err := collections.MoveCollection(ctx, admin, personal.ID, nil, &projectID); err != nil {
			t.Fatalf("personal-to-project move: %v", err)
		}
		permitted := createCollection("Maintainer can delete", domain.ProjectRoleMaintainer)
		if err := collections.DeleteCollection(ctx, maintainer, permitted.ID); err != nil {
			t.Fatal(err)
		}
		if err := environments.Delete(ctx, maintainer, env.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("pull completes with one connection and cancellation releases it", func(t *testing.T) {
		short, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		delta, err := syncService.PullDelta(short, contributor, nil, &projectID, time.Unix(0, 0))
		if err != nil || delta == nil {
			t.Fatalf("single connection pull: %v", err)
		}
		for _, col := range delta.Collections {
			if col.ID == restricted.ID {
				t.Fatal("restricted collection leaked")
			}
		}
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := syncService.PullDelta(canceled, contributor, nil, &projectID, time.Unix(0, 0)); err == nil {
			t.Fatal("canceled query succeeded")
		}
		if err := a.Pool.Ping(short); err != nil {
			t.Fatal("connection leaked", err)
		}
		// Failure in a later delta query must not return successful partial data.
		exec("ALTER TABLE environments RENAME TO environments_unavailable")
		delta, err = syncService.PullDelta(ctx, contributor, nil, &projectID, time.Unix(0, 0))
		exec("ALTER TABLE environments_unavailable RENAME TO environments")
		if err == nil || delta != nil {
			t.Fatalf("partial delta returned: %+v %v", delta, err)
		}
	})

	t.Run("audit regression tests covering findings 1 through 8", func(t *testing.T) {
		auditTarget := createCollection("Audit validation target", domain.ProjectRoleReader)
		// Finding 1: Malformed payloads rejected with 400
		assertStatus(request("POST", "/api/v1/items", contributorTokens.AccessToken, map[string]any{
			"collection_id": auditTarget.ID.String(),
			"name":          "Malformed headers",
			"type":          "request",
			"headers":       map[string]any{},
		}), 400)

		assertStatus(request("POST", "/api/v1/items", contributorTokens.AccessToken, map[string]any{
			"collection_id": auditTarget.ID.String(),
			"name":          "Malformed params",
			"type":          "request",
			"params":        []any{nil},
		}), 400)

		// Finding 2: Item mutation bumps collection.version and collection.updated_at
		auditCol := createCollection("Audit Col", domain.ProjectRoleReader)
		initialVer := auditCol.Version
		time.Sleep(10 * time.Millisecond)

		reqItem := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: auditCol.ID,
			Name:         "Request 1",
			Type:         domain.ItemTypeRequest,
		}
		if err := collections.CreateItem(ctx, contributor, reqItem); err != nil {
			t.Fatalf("failed to create valid item: %v", err)
		}
		afterCreateCol, err := collections.GetCollection(ctx, contributor, auditCol.ID)
		if err != nil {
			t.Fatal(err)
		}
		if afterCreateCol.Version <= initialVer {
			t.Fatalf("expected collection version to increment on item create, was %d, now %d", initialVer, afterCreateCol.Version)
		}

		// Update item bumps version again
		time.Sleep(10 * time.Millisecond)
		reqItem.Name = "Request 1 Updated"
		_, err = collections.UpdateItem(ctx, contributor, reqItem, 1)
		if err != nil {
			t.Fatalf("failed to update item: %v", err)
		}
		afterUpdateCol, err := collections.GetCollection(ctx, contributor, auditCol.ID)
		if err != nil {
			t.Fatal(err)
		}
		if afterUpdateCol.Version <= afterCreateCol.Version {
			t.Fatalf("expected collection version to increment on item update, was %d, now %d", afterCreateCol.Version, afterUpdateCol.Version)
		}

		// Finding 3: parent_id cross-collection, self-cycle, and invalid type rejected
		assertStatus(request("POST", "/api/v1/items", contributorTokens.AccessToken, map[string]any{
			"collection_id": auditTarget.ID.String(),
			"name":          "Cross-collection parent",
			"type":          "request",
			"parent_id":     reqItem.ID.String(),
		}), 400)

		assertStatus(request("PUT", "/api/v1/items/"+reqItem.ID.String(), contributorTokens.AccessToken, map[string]any{
			"base_version": 2,
			"item": map[string]any{
				"name":      "Self parent",
				"type":      "request",
				"parent_id": reqItem.ID.String(),
			},
		}), 400)

		// Finding 4: Delete folder soft-deletes descendant subtree
		folder := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: auditCol.ID,
			Name:         "Folder 1",
			Type:         domain.ItemTypeFolder,
		}
		if err := collections.CreateItem(ctx, contributor, folder); err != nil {
			t.Fatal(err)
		}
		child := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: auditCol.ID,
			ParentID:     &folder.ID,
			Name:         "Child Req",
			Type:         domain.ItemTypeRequest,
		}
		if err := collections.CreateItem(ctx, contributor, child); err != nil {
			t.Fatal(err)
		}
		if err := collections.DeleteItem(ctx, contributor, folder.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := collections.GetItem(ctx, contributor, child.ID); !errors.Is(err, postgres.ErrItemNotFound) {
			t.Fatalf("expected child to be deleted with parent folder, got err: %v", err)
		}

		// Finding 5: Deleted collection rejects new items and reading existing items
		deletedCol := createCollection("To Be Deleted", domain.ProjectRoleReader)
		dItem := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: deletedCol.ID,
			Name:         "Item in deleted col",
			Type:         domain.ItemTypeRequest,
		}
		if err := collections.CreateItem(ctx, contributor, dItem); err != nil {
			t.Fatal(err)
		}
		if err := collections.DeleteCollection(ctx, admin, deletedCol.ID); err != nil {
			t.Fatal(err)
		}
		newItemInDeleted := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: deletedCol.ID,
			Name:         "Late item",
			Type:         domain.ItemTypeRequest,
		}
		if err := collections.CreateItem(ctx, contributor, newItemInDeleted); !errors.Is(err, postgres.ErrCollectionNotFound) {
			t.Fatalf("expected ErrCollectionNotFound when creating item in deleted collection, got: %v", err)
		}
		if _, err := collections.GetItem(ctx, contributor, dItem.ID); !errors.Is(err, postgres.ErrItemNotFound) {
			t.Fatalf("expected ErrItemNotFound when reading item in deleted collection, got: %v", err)
		}

		// Finding 7: OCC 409 Conflict returns current server entity
		serverCol := createCollection("Server truth", domain.ProjectRoleReader)
		conflictResp := request("PUT", "/api/v1/collections/"+serverCol.ID.String(), contributorTokens.AccessToken, map[string]any{
			"base_version": 99,
			"name":         "Stale client",
		})
		assertStatus(conflictResp, 409)
		var conflictData struct {
			Data struct {
				Name    string `json:"name"`
				Version int64  `json:"version"`
			} `json:"data"`
		}
		if err := json.NewDecoder(conflictResp.Body).Decode(&conflictData); err != nil {
			t.Fatal(err)
		}
		if conflictData.Data.Name != "Server truth" {
			t.Fatalf("expected 409 data to contain server truth name 'Server truth', got '%s'", conflictData.Data.Name)
		}
		if conflictData.Data.Version == 0 {
			t.Fatalf("expected 409 data to contain server version > 0, got %d", conflictData.Data.Version)
		}

		// Finding 8: MoveCollection updates child items updated_at timestamp atomically
		moveCol := createCollection("Move Col", domain.ProjectRoleReader)
		mItem := &domain.CollectionItem{
			ID:           uuid.New(),
			CollectionID: moveCol.ID,
			Name:         "Item in moved col",
			Type:         domain.ItemTypeRequest,
		}
		if err := collections.CreateItem(ctx, contributor, mItem); err != nil {
			t.Fatal(err)
		}
		itemBeforeMove, err := collections.GetItem(ctx, contributor, mItem.ID)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)

		targetProjID := uuid.New()
		exec("INSERT INTO projects (id,team_id,name,created_by) VALUES ($1,$2,'Target project',$3)", targetProjID, teamID, admin.ID)
		exec("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'admin')", targetProjID, admin.ID)
		exec("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'contributor')", targetProjID, contributor.ID)

		if err := collections.MoveCollection(ctx, admin, moveCol.ID, nil, &targetProjID); err != nil {
			t.Fatalf("failed to move collection: %v", err)
		}
		itemAfterMove, err := collections.GetItem(ctx, contributor, mItem.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !itemAfterMove.UpdatedAt.After(itemBeforeMove.UpdatedAt) {
			t.Fatalf("expected item.updated_at to be bumped on move, before=%v, after=%v", itemBeforeMove.UpdatedAt, itemAfterMove.UpdatedAt)
		}
	})

	t.Run("gzip import is atomic and rejects trailing JSON", func(t *testing.T) {
		requestGzip := func(payload []byte) *httptest.ResponseRecorder {
			t.Helper()
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			if _, err := writer.Write(payload); err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/api/v1/sync/import-batch", &compressed).WithContext(ctx)
			req.Header.Set("Authorization", "Bearer "+contributorTokens.AccessToken)
			req.Header.Set("Content-Encoding", "gzip")
			w := httptest.NewRecorder()
			a.Router.ServeHTTP(w, req)
			return w
		}

		validID := uuid.New()
		validPayload, err := json.Marshal(map[string]any{
			"project_id": projectID.String(),
			"collections": []service.ImportCollectionRequest{{
				ID:   validID.String(),
				Name: "Gzip import",
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertStatus(requestGzip(validPayload), 200)
		if _, err := collections.GetCollection(ctx, contributor, validID); err != nil {
			t.Fatalf("gzip import did not persist collection: %v", err)
		}

		trailingID := uuid.New()
		trailingPayload, err := json.Marshal(map[string]any{
			"project_id": projectID.String(),
			"collections": []service.ImportCollectionRequest{{
				ID:   trailingID.String(),
				Name: "Trailing JSON must not write",
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertStatus(requestGzip(append(trailingPayload, []byte(" {}")...)), 400)
		if _, err := collections.GetCollection(ctx, contributor, trailingID); !errors.Is(err, postgres.ErrCollectionNotFound) {
			t.Fatalf("trailing JSON wrote a collection: %v", err)
		}
	})

	t.Run("HTTP limits reject before mutation", func(t *testing.T) {
		assertStatus(request("POST", "/api/v1/sync/push", contributorTokens.AccessToken, service.SyncPushRequest{ProjectID: &projectID, Items: make([]service.SyncItemMutation, service.MaxSyncMutations+1)}), 413)
		for _, length := range []int64{-1, (4 << 20) + 1} {
			req := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(strings.Repeat(" ", (4<<20)+1))).WithContext(ctx)
			req.ContentLength = length
			if length < 0 {
				req.TransferEncoding = []string{"chunked"}
			}
			w := httptest.NewRecorder()
			a.Router.ServeHTTP(w, req)
			assertStatus(w, 413)
		}
	})
	fmt.Fprintln(os.Stdout, "security integration suite verified with isolated schema and single-connection pool")
}
