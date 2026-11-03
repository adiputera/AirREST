package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/core/service"
)

func TestUserHandler_Search(t *testing.T) {
	authService := service.NewAuthService(nil, nil)
	userHandler := NewUserHandler(authService)

	t.Run("Returns empty array for query length < 2", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/users/search?q=a", nil)
		w := httptest.NewRecorder()
		userHandler.Search(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", w.Code)
		}

		var res struct {
			Success bool  `json:"success"`
			Data    []any `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if len(res.Data) != 0 {
			t.Fatalf("expected 0 users for short query, got %d", len(res.Data))
		}
	})
}
