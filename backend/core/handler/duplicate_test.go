package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func withChiParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestDuplicateHandlers_InputAndPayloadValidation(t *testing.T) {
	svc := service.NewDuplicateService(nil)
	h := NewDuplicateHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}

	t.Run("unauthenticated collection duplicate returns 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/collections/"+uuid.NewString()+"/duplicate", bytes.NewBufferString(`{}`))
		req = withChiParam(req, "id", uuid.NewString())
		rr := httptest.NewRecorder()
		h.DuplicateCollection(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rr.Code)
		}
	})

	t.Run("collection duplicate rejects invalid UUIDs and dual/empty scope", func(t *testing.T) {
		cases := []struct {
			id      string
			payload string
		}{
			{"not-a-uuid", `{"operation_id":"` + uuid.NewString() + `","target_workspace_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"bad","target_workspace_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"` + uuid.NewString() + `","target_workspace_id":"` + uuid.NewString() + `","target_project_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"` + uuid.NewString() + `","target_workspace_id":"bad-uuid"}`},
		}
		for _, tc := range cases {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collections/"+tc.id+"/duplicate", bytes.NewBufferString(tc.payload))
			req = withChiParam(req, "id", tc.id)
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
			rr := httptest.NewRecorder()
			h.DuplicateCollection(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for payload %s, got %d (%s)", tc.payload, rr.Code, rr.Body.String())
			}
		}
	})

	t.Run("item duplicate rejects invalid UUIDs and target_parent_id", func(t *testing.T) {
		cases := []struct {
			id      string
			payload string
		}{
			{"bad", `{"operation_id":"` + uuid.NewString() + `","source_collection_id":"` + uuid.NewString() + `","target_collection_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"` + uuid.NewString() + `","source_collection_id":"bad","target_collection_id":"` + uuid.NewString() + `"}`},
			{uuid.NewString(), `{"operation_id":"` + uuid.NewString() + `","source_collection_id":"` + uuid.NewString() + `","target_collection_id":"` + uuid.NewString() + `","target_parent_id":"bad"}`},
		}
		for _, tc := range cases {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/items/"+tc.id+"/duplicate", bytes.NewBufferString(tc.payload))
			req = withChiParam(req, "id", tc.id)
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
			rr := httptest.NewRecorder()
			h.DuplicateItem(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for item payload %s, got %d (%s)", tc.payload, rr.Code, rr.Body.String())
			}
		}
	})

	t.Run("import-duplicate rejects invalid form-data metadata types and 151-rune names with 400", func(t *testing.T) {
		badMetaPayload := `{
			"operation_id":"` + uuid.NewString() + `",
			"target_workspace_id":"` + uuid.NewString() + `",
			"collection":{
				"name":"Offline Col",
				"items":[{
					"type":"request",
					"name":"Upload",
					"body_type":"form-data",
					"body_form_data":[{"key":"f","type":"file","fileSize":"not-int","needsReselection":"yes"}]
				}]
			}
		}`
		req := httptest.NewRequest(http.MethodPost, "/api/v1/collections/import-duplicate", bytes.NewBufferString(badMetaPayload))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
		rr := httptest.NewRecorder()
		h.ImportDuplicateCollection(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for invalid form-data metadata, got %d (%s)", rr.Code, rr.Body.String())
		}

		longNamePayload := `{
			"operation_id":"` + uuid.NewString() + `",
			"target_workspace_id":"` + uuid.NewString() + `",
			"collection":{
				"name":"` + strings.Repeat("🚀", 151) + `",
				"items":[]
			}
		}`
		req2 := httptest.NewRequest(http.MethodPost, "/api/v1/collections/import-duplicate", bytes.NewBufferString(longNamePayload))
		req2 = req2.WithContext(context.WithValue(req2.Context(), middleware.UserContextKey, user))
		rr2 := httptest.NewRecorder()
		h.ImportDuplicateCollection(rr2, req2)
		if rr2.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for 151-rune collection name, got %d (%s)", rr2.Code, rr2.Body.String())
		}

		var resp struct {
			Success bool   `json:"success"`
			Code    string `json:"code"`
		}
		if err := json.Unmarshal(rr2.Body.Bytes(), &resp); err != nil || resp.Success || resp.Code != "BAD_REQUEST" {
			t.Fatalf("unexpected error envelope: %s", rr2.Body.String())
		}
	})
}
