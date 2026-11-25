package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func withChiIDParam(req *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestCollectionHandler_PatchItemExamples_ValidationAndLimits(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}

	oversizedBody := `"` + strings.Repeat("a", service.MaxSavedExampleBytes) + `"`

	cases := []struct {
		name       string
		itemID     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{
			name:       "invalid item id",
			itemID:     "bad-uuid",
			body:       `{}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "malformed json",
			itemID:     uuid.New().String(),
			body:       `{invalid`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "missing operation_id",
			itemID:     uuid.New().String(),
			body:       `{"op":"add","base_version":1}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "invalid op",
			itemID:     uuid.New().String(),
			body:       `{"operation_id":"` + uuid.NewString() + `","op":"truncate","base_version":1}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "rename missing base_example_revision",
			itemID:     uuid.New().String(),
			body:       `{"operation_id":"` + uuid.NewString() + `","op":"rename","base_version":1,"example_id":"ex-1","name":"Renamed"}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "add unsupported content-type",
			itemID:     uuid.New().String(),
			body:       `{"operation_id":"` + uuid.NewString() + `","op":"add","base_version":1,"example":{"id":"ex-1","name":"Img","status":"OK","code":200,"header":[{"key":"Content-Type","value":"image/svg+xml"}],"body":"<svg/>"}}`,
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "add single example exceeding 512 KiB returns 413",
			itemID:     uuid.New().String(),
			body:       fmtJSONAddExample(oversizedBody),
			wantStatus: http.StatusRequestEntityTooLarge,
			wantCode:   "LIMIT_EXCEEDED",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/api/v1/items/"+tc.itemID+"/examples", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = withChiIDParam(req, tc.itemID)
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

			rr := httptest.NewRecorder()
			h.PatchItemExamples(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("expected %d, got %d; body=%s", tc.wantStatus, rr.Code, rr.Body.String())
			}
			var resp struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.Code != tc.wantCode {
				t.Fatalf("expected code %q, got %q", tc.wantCode, resp.Code)
			}
		})
	}
}

func fmtJSONAddExample(bodyLiteral string) string {
	b, _ := json.Marshal(map[string]any{
		"operation_id": uuid.NewString(),
		"op":           "add",
		"base_version": 1,
		"example": map[string]any{
			"id":     "ex-big",
			"name":   "Oversized",
			"status": "OK",
			"code":   200,
			"header": []map[string]string{{"key": "Content-Type", "value": "application/json"}},
			"body":   bodyLiteral,
		},
	})
	return string(b)
}

func TestCollectionHandler_GetCollectionExamples_Validation(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}

	cases := []struct {
		name   string
		colID  string
		target string
	}{
		{"invalid collection id", "not-a-uuid", "/api/v1/collections/not-a-uuid/examples"},
		{"zero limit", uuid.NewString(), "/api/v1/collections/" + uuid.NewString() + "/examples?limit=0"},
		{"non-numeric limit", uuid.NewString(), "/api/v1/collections/" + uuid.NewString() + "/examples?limit=abc"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			req = withChiIDParam(req, tc.colID)
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
			rr := httptest.NewRecorder()
			h.GetCollectionExamples(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestCollectionHandler_ReplaceCollection_Validation(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}

	colID := uuid.NewString()
	cases := []struct {
		name  string
		colID string
		body  string
	}{
		{"invalid collection id", "bad-id", `{}`},
		{"malformed json", colID, `{bad`},
		{"missing operation_id", colID, `{"base_version":1,"collection":{"name":"Replaced"}}`},
		{"base_version < 1", colID, `{"operation_id":"` + uuid.NewString() + `","base_version":0,"collection":{"name":"Replaced"}}`},
		{"empty collection name", colID, `{"operation_id":"` + uuid.NewString() + `","base_version":1,"collection":{"name":""}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collections/"+tc.colID+"/replace", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = withChiIDParam(req, tc.colID)
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
			rr := httptest.NewRecorder()
			h.ReplaceCollection(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestCollectionHandler_UpdateItem_NullExamplesRejected(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}
	itemID := uuid.NewString()

	payload := `{"base_version":1,"item":{"collection_id":"` + uuid.NewString() + `","name":"Req","type":"request","examples":null}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/items/"+itemID, bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	req = withChiIDParam(req, itemID)
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))
	rr := httptest.NewRecorder()
	h.UpdateItem(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for explicit null examples, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestFeaturePolicyHandler_Get_IncludesSavedExamplesCapability(t *testing.T) {
	store := &featurePolicyHandlerStore{
		policy: &domain.FeaturePolicy{
			Flags:     domain.DefaultFeatureFlags(),
			Revision:  1,
			UpdatedAt: time.Now().UTC(),
		},
	}
	h := NewFeaturePolicyHandler(service.NewFeaturePolicyService(store))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/feature-policy", nil)
	rr := httptest.NewRecorder()
	h.Get(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			Capabilities struct {
				SavedExamples bool `json:"saved_examples"`
			} `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.Success || !payload.Data.Capabilities.SavedExamples {
		t.Fatalf("expected capabilities.saved_examples=true, got %+v", payload)
	}
}
