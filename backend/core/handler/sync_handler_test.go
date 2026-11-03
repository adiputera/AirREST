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
	"github.com/google/uuid"
)

func TestSyncHandler_Validation(t *testing.T) {
	syncService := service.NewSyncService(nil, nil, nil, nil, nil)
	syncHandler := NewSyncHandler(syncService)

	user := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	t.Run("Push rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/sync/push", bytes.NewBufferString(`{malformed`))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		syncHandler.Push(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("ImportBatch rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/sync/import", bytes.NewBufferString(`{malformed`))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		syncHandler.ImportBatch(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})

	t.Run("ImportBatch rejects invalid workspace UUID string", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/sync/import", bytes.NewBufferString(`{"workspace_id":"invalid-uuid"}`))
		req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, user))

		w := httptest.NewRecorder()
		syncHandler.ImportBatch(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
