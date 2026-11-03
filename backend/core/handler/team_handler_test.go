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

func TestTeamHandler_Validation(t *testing.T) {
	teamService := service.NewTeamService(nil, nil)
	teamHandler := NewTeamHandler(teamService)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	t.Run("Create rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/teams", bytes.NewBufferString(`{malformed`))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		teamHandler.Create(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("Get rejects invalid team UUID", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/teams/invalid-uuid", nil)
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", "invalid-uuid")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		teamHandler.Get(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("AddMember rejects malformed JSON", func(t *testing.T) {
		validUUID := uuid.New().String()
		req := httptest.NewRequest(http.MethodPost, "/teams/"+validUUID+"/members", bytes.NewBufferString(`{malformed`))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("id", validUUID)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		teamHandler.AddMember(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
