package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

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
