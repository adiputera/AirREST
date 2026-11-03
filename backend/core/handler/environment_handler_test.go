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

func TestEnvironmentHandler_Validation(t *testing.T) {
	envService := service.NewEnvironmentService(nil, nil, nil)
	envHandler := NewEnvironmentHandler(envService)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	t.Run("Get rejects invalid environment UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/environments/invalid-uuid", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		envHandler.Get(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Update rejects invalid environment UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/environments/invalid-uuid", bytes.NewBufferString(`{"name":"New Env","base_version":1}`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		envHandler.Update(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Update rejects malformed JSON body", func(t *testing.T) {
		validUUID := uuid.New().String()
		req := httptest.NewRequest(http.MethodPut, "/environments/"+validUUID, bytes.NewBufferString(`{malformed`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", validUUID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		envHandler.Update(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Delete rejects invalid environment UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/environments/invalid-uuid", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		envHandler.Delete(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
