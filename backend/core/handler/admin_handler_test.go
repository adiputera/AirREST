package handler

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/core/service"
	"github.com/go-chi/chi/v5"
)

func TestAdminHandler_UpdateUser(t *testing.T) {
	authService := service.NewAuthService(nil, nil)
	adminHandler := NewAdminHandler(authService)

	t.Run("Rejects invalid uuid", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/admin/users/invalid-uuid", bytes.NewBufferString(`{"name":"New Name"}`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("userId", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

		w := httptest.NewRecorder()
		adminHandler.UpdateUser(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Rejects invalid JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/admin/users/00000000-0000-0000-0000-000000000001", bytes.NewBufferString(`{invalid`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("userId", "00000000-0000-0000-0000-000000000001")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

		w := httptest.NewRecorder()
		adminHandler.UpdateUser(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Rejects empty name", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/admin/users/00000000-0000-0000-0000-000000000001", bytes.NewBufferString(`{"name":"   "}`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("userId", "00000000-0000-0000-0000-000000000001")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

		w := httptest.NewRecorder()
		adminHandler.UpdateUser(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
