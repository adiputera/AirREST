package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestCreateItem_RejectsMalformedPayloads(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	testCases := []struct {
		name       string
		payload    string
		wantStatus int
	}{
		{
			name: "headers is an object instead of array",
			payload: `{
				"collection_id": "00000000-0000-0000-0000-000000000001",
				"name": "Test Request",
				"type": "request",
				"headers": {}
			}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "params contains a null element",
			payload: `{
				"collection_id": "00000000-0000-0000-0000-000000000001",
				"name": "Test Request",
				"type": "request",
				"params": [null]
			}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "auth is an array instead of object",
			payload: `{
				"collection_id": "00000000-0000-0000-0000-000000000001",
				"name": "Test Request",
				"type": "request",
				"auth": []
			}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "auth contains unsupported type",
			payload: `{
				"collection_id": "00000000-0000-0000-0000-000000000001",
				"name": "Test Request",
				"type": "request",
				"auth": {"type": "oauth1_unsupported"}
			}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/items", bytes.NewBufferString(tc.payload))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

			rr := httptest.NewRecorder()
			h.CreateItem(rr, req)

			if rr.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d. Body: %s", tc.wantStatus, rr.Code, rr.Body.String())
			}

			var resp struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
				Code    string `json:"code"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if resp.Success {
				t.Fatalf("expected failure, got success")
			}
			if resp.Code != "BAD_REQUEST" {
				t.Fatalf("expected code BAD_REQUEST, got %s", resp.Code)
			}
		})
	}
}

func TestUpdateItem_RejectsMalformedPayloads(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	itemID := uuid.New()
	payload := `{
		"base_version": 1,
		"item": {
			"name": "Invalid Request",
			"type": "request",
			"headers": {}
		}
	}`

	req := httptest.NewRequest(http.MethodPut, "/api/v1/items/"+itemID.String(), bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", itemID.String())
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

	rr := httptest.NewRecorder()
	h.UpdateItem(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400 Bad Request, got %d. Body: %s", rr.Code, rr.Body.String())
	}
}

func TestMoveCollection_RejectsInvalidRequestsWith400(t *testing.T) {
	svc := service.NewCollectionService(nil, nil, nil, nil)
	h := NewCollectionHandler(svc)
	user := &domain.User{ID: uuid.New(), Role: domain.RoleUser}

	cases := []struct {
		name   string
		colID  string
		body   string
	}{
		{name: "invalid collection id", colID: "not-a-uuid", body: `{}`},
		{name: "invalid json body", colID: uuid.New().String(), body: `{bad`},
		{name: "invalid target_workspace_id", colID: uuid.New().String(), body: `{"target_workspace_id":"bad-uuid"}`},
		{name: "invalid target_project_id", colID: uuid.New().String(), body: `{"target_project_id":"bad-uuid"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/collections/"+tc.colID+"/move", bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", tc.colID)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

			rr := httptest.NewRecorder()
			h.Move(rr, req)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected status 400, got %d. Body: %s", rr.Code, rr.Body.String())
			}
		})
	}
}

func TestWriteMoveCollectionError_MapsAllStatusCodesWithoutLeakingDBErrors(t *testing.T) {
	cases := []struct {
		name           string
		err            error
		wantStatus     int
		wantCode       string
		forbidSubstr   string
	}{
		{
			name:       "feature disabled",
			err:        service.ErrFeatureDisabled,
			wantStatus: http.StatusForbidden,
			wantCode:   "FEATURE_DISABLED",
		},
		{
			name:       "feature policy unavailable",
			err:        service.ErrFeaturePolicyUnavailable,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "FEATURE_POLICY_UNAVAILABLE",
		},
		{
			name:       "invalid collection move",
			err:        fmt.Errorf("%w: cross-team move", service.ErrInvalidCollectionMove),
			wantStatus: http.StatusBadRequest,
			wantCode:   "BAD_REQUEST",
		},
		{
			name:       "forbidden",
			err:        service.ErrForbidden,
			wantStatus: http.StatusForbidden,
			wantCode:   "FORBIDDEN",
		},
		{
			name:       "project to personal forbidden",
			err:        service.ErrProjectCollectionMoveToPersonalScope,
			wantStatus: http.StatusForbidden,
			wantCode:   "FORBIDDEN",
		},
		{
			name:       "collection not found",
			err:        postgres.ErrCollectionNotFound,
			wantStatus: http.StatusNotFound,
			wantCode:   "NOT_FOUND",
		},
		{
			name:       "version conflict TOCTOU",
			err:        postgres.ErrVersionConflict,
			wantStatus: http.StatusConflict,
			wantCode:   "CONFLICT",
		},
		{
			name:         "unexpected DB error does not leak internal details",
			err:          errors.New(`pq: deadlock detected on relation "collections"`),
			wantStatus:   http.StatusInternalServerError,
			wantCode:     "SERVER_ERROR",
			forbidSubstr: "deadlock",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			writeMoveCollectionError(rr, tc.err)
			if rr.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d (%s)", tc.wantStatus, rr.Code, rr.Body.String())
			}
			var resp struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
				Code    string `json:"code"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.Code != tc.wantCode {
				t.Fatalf("expected code %q, got %q", tc.wantCode, resp.Code)
			}
			if tc.forbidSubstr != "" && strings.Contains(strings.ToLower(rr.Body.String()), tc.forbidSubstr) {
				t.Fatalf("response leaked internal error detail %q: %s", tc.forbidSubstr, rr.Body.String())
			}
		})
	}
}
