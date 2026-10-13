package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/adiputera/airrest-backend/internal/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/google/uuid"
)

type contextKey string

const (
	UserContextKey contextKey = "currentUser"
)

// Authenticate extracts and validates JWT from Authorization: Bearer <token>
func Authenticate(tm *token.TokenManager, authService *service.AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				response.Error(w, http.StatusUnauthorized, "missing authorization header", "UNAUTHORIZED")
				return
			}

			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
				response.Error(w, http.StatusUnauthorized, "invalid authorization header format, expected 'Bearer <token>'", "UNAUTHORIZED")
				return
			}

			tokenStr := parts[1]
			claims, err := tm.ValidateToken(tokenStr)
			if err != nil {
				response.Error(w, http.StatusUnauthorized, "invalid or expired token", "TOKEN_EXPIRED")
				return
			}

			// Load user from database to ensure user still exists and hasn't changed roles
			user, err := authService.GetUserByID(r.Context(), claims.UserID)
			if err != nil {
				response.Error(w, http.StatusUnauthorized, "user account not found or deactivated", "UNAUTHORIZED")
				return
			}

			ctx := context.WithValue(r.Context(), UserContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireSuperadmin ensures the authenticated user is a Superadmin
func RequireSuperadmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := GetUserFromContext(r.Context())
		if user == nil {
			response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
			return
		}

		if !user.IsSuperadmin() {
			response.Error(w, http.StatusForbidden, "forbidden: superadmin access required", "FORBIDDEN")
			return
		}

		next.ServeHTTP(w, r)
	})
}

// GetUserFromContext extracts the *domain.User from request context
func GetUserFromContext(ctx context.Context) *domain.User {
	if val := ctx.Value(UserContextKey); val != nil {
		if user, ok := val.(*domain.User); ok {
			return user
		}
	}
	return nil
}

// GetUserIDFromContext extracts the user UUID from request context
func GetUserIDFromContext(ctx context.Context) (uuid.UUID, bool) {
	user := GetUserFromContext(ctx)
	if user == nil {
		return uuid.Nil, false
	}
	return user.ID, true
}
