package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/core/service"
)

func TestAuthHandler_Register(t *testing.T) {
	authService := service.NewAuthService(nil, nil)
	authHandler := NewAuthHandler(authService)

	t.Run("Register is permanently disabled with 403", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewBufferString(`{"email":"test@example.com","password":"Password123!","name":"Tester"}`))
		w := httptest.NewRecorder()
		authHandler.Register(w, req)

		if w.Code != http.StatusForbidden {
			t.Fatalf("expected status 403, got %d", w.Code)
		}

		var res map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if res["code"] != "REGISTRATION_DISABLED" {
			t.Fatalf("expected code REGISTRATION_DISABLED, got %v", res["code"])
		}
	})
}

func TestAuthHandler_Login(t *testing.T) {
	authService := service.NewAuthService(nil, nil)
	authHandler := NewAuthHandler(authService)

	t.Run("Rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewBufferString(`{invalid-json`))
		w := httptest.NewRecorder()
		authHandler.Login(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}

func TestAuthHandler_Refresh(t *testing.T) {
	authService := service.NewAuthService(nil, nil)
	authHandler := NewAuthHandler(authService)

	t.Run("Rejects empty refresh token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewBufferString(`{"refresh_token":""}`))
		w := httptest.NewRecorder()
		authHandler.Refresh(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}

		var res map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if res["code"] != "VALIDATION_ERROR" {
			t.Fatalf("expected code VALIDATION_ERROR, got %v", res["code"])
		}
	})

	t.Run("Rejects malformed JSON body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewBufferString(`{malformed`))
		w := httptest.NewRecorder()
		authHandler.Refresh(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", w.Code)
		}
	})
}
