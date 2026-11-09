package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/google/uuid"
)

type testUserResolver struct {
	user *domain.User
	err  error
}

func (r testUserResolver) GetUserByID(context.Context, uuid.UUID) (*domain.User, error) {
	return r.user, r.err
}

type testAuthenticator struct{ user *domain.User }

func (a testAuthenticator) Authenticate(*http.Request) (*domain.User, *AuthenticationError) {
	return a.user, nil
}

func TestPasswordAuthenticatorAndSubstitution(t *testing.T) {
	id := uuid.New()
	manager := token.NewTokenManager("test-signing-key-at-least-32-bytes-long", 1)
	valid, _, err := manager.GenerateToken(id, "tester@example.com", "superadmin", 4)
	if err != nil {
		t.Fatal(err)
	}
	user := &domain.User{ID: id, Role: domain.RoleUser, TokenVersion: 4}
	assertHandler := func(auth Authenticator, bearer string, status int, code string) {
		t.Helper()
		handler := AuthenticateWith(auth)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := GetUserFromContext(r.Context()); got == nil || got.Role != domain.RoleUser {
				t.Errorf("expected database user and role, got %#v", got)
			}
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != status || (code != "" && !strings.Contains(rr.Body.String(), code)) {
			t.Errorf("status %d body %s", rr.Code, rr.Body.String())
		}
	}
	assertHandler(NewPasswordAuthenticator(manager, testUserResolver{user: user}), "Bearer "+valid, http.StatusNoContent, "")
	assertHandler(NewPasswordAuthenticator(manager, testUserResolver{user: &domain.User{ID: id, TokenVersion: 5}}), "Bearer "+valid, http.StatusUnauthorized, "SESSION_REVOKED")
	assertHandler(NewPasswordAuthenticator(manager, testUserResolver{err: postgres.ErrUserNotFound}), "Bearer "+valid, http.StatusUnauthorized, "UNAUTHORIZED")
	assertHandler(NewPasswordAuthenticator(manager, testUserResolver{err: errors.New("unavailable")}), "Bearer "+valid, http.StatusInternalServerError, "DATABASE_ERROR")
	assertHandler(NewPasswordAuthenticator(manager, testUserResolver{user: user}), "Bearer invalid", http.StatusUnauthorized, "TOKEN_EXPIRED")
	assertHandler(testAuthenticator{user: user}, "", http.StatusNoContent, "")
}

func TestRequireSuperadmin(t *testing.T) {
	tests := []struct {
		name           string
		user           *domain.User
		expectedStatus int
	}{
		{
			name: "superadmin allowed",
			user: &domain.User{
				ID:   uuid.New(),
				Role: domain.RoleSuperadmin,
			},
			expectedStatus: http.StatusOK,
		},
		{
			name: "standard user forbidden",
			user: &domain.User{
				ID:   uuid.New(),
				Role: domain.RoleUser,
			},
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "unauthenticated forbidden",
			user:           nil,
			expectedStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := RequireSuperadmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest("GET", "/api/v1/admin/users", nil)
			if tt.user != nil {
				ctx := context.WithValue(req.Context(), UserContextKey, tt.user)
				req = req.WithContext(ctx)
			}

			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, rr.Code)
			}
		})
	}
}
