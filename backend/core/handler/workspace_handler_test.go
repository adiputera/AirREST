package handler

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestWorkspaceHandler_Validation(t *testing.T) {
	wsService := service.NewWorkspaceService(nil)
	wsHandler := NewWorkspaceHandler(wsService)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	t.Run("Create rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/workspaces", bytes.NewBufferString(`{invalid`))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		wsHandler.Create(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get rejects invalid workspace UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/workspaces/invalid-uuid", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		wsHandler.Get(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Update rejects invalid workspace UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/workspaces/invalid-uuid", bytes.NewBufferString(`{"name":"New Name"}`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		wsHandler.Update(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Update rejects malformed JSON", func(t *testing.T) {
		validUUID := uuid.New().String()
		req := httptest.NewRequest(http.MethodPut, "/workspaces/"+validUUID, bytes.NewBufferString(`{malformed`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", validUUID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		wsHandler.Update(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
