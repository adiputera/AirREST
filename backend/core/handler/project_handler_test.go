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

func TestProjectHandler_Validation(t *testing.T) {
	projectService := service.NewProjectService(nil, nil, nil)
	projectHandler := NewProjectHandler(projectService)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	t.Run("ListByTeam rejects invalid team UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/teams/invalid-uuid/projects", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("teamId", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		projectHandler.ListByTeam(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Create rejects malformed JSON", func(t *testing.T) {
		validUUID := uuid.New().String()
		req := httptest.NewRequest(http.MethodPost, "/teams/"+validUUID+"/projects", bytes.NewBufferString(`{malformed`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("teamId", validUUID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		projectHandler.Create(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get rejects invalid project UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/projects/invalid-uuid", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		projectHandler.Get(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
