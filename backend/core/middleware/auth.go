package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/google/uuid"
)

type contextKey string

const (
	UserContextKey contextKey = "currentUser"
)

// TokenVerifier validates an access credential. The password adapter retains JWT
// token-version checks after resolving the current user from the database.
type TokenVerifier interface {
	ValidateToken(string) (*token.CustomClaims, error)
}

type UserResolver interface {
	GetUserByID(context.Context, uuid.UUID) (*domain.User, error)
}

type AuthenticationError struct {
	Status  int
	Message string
	Code    string
}

// Authenticator may implement a different credential protocol while returning
// the application user used by the existing resource authorization checks.
type Authenticator interface {
	Authenticate(*http.Request) (*domain.User, *AuthenticationError)
}

type passwordAuthenticator struct {
	verifier TokenVerifier
	users    UserResolver
}

func NewPasswordAuthenticator(verifier TokenVerifier, users UserResolver) Authenticator {
	return &passwordAuthenticator{verifier: verifier, users: users}
}

// Authenticate remains available for callers using the original JWT adapter.
func Authenticate(verifier TokenVerifier, users UserResolver) func(http.Handler) http.Handler {
	return AuthenticateWith(NewPasswordAuthenticator(verifier, users))
}

func AuthenticateWith(authenticator Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, authErr := authenticator.Authenticate(r)
			if authErr != nil {
				response.Error(w, authErr.Status, authErr.Message, authErr.Code)
				return
			}
			if user == nil {
				response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
				return
			}
			ctx := context.WithValue(r.Context(), UserContextKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (a *passwordAuthenticator) Authenticate(r *http.Request) (*domain.User, *AuthenticationError) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, &AuthenticationError{http.StatusUnauthorized, "missing authorization header", "UNAUTHORIZED"}
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
		return nil, &AuthenticationError{http.StatusUnauthorized, "invalid authorization header format, expected 'Bearer <token>'", "UNAUTHORIZED"}
	}

	tokenStr := parts[1]
	claims, err := a.verifier.ValidateToken(tokenStr)
	if err != nil || claims == nil {
		return nil, &AuthenticationError{http.StatusUnauthorized, "invalid or expired token", "TOKEN_EXPIRED"}
	}

	// Load user from database to ensure user still exists and hasn't changed roles
	user, err := a.users.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("auth middleware: failed to load user from database", "user_id", claims.UserID, "error", err)
		if errors.Is(err, postgres.ErrUserNotFound) {
			return nil, &AuthenticationError{http.StatusUnauthorized, "user account not found or deactivated", "UNAUTHORIZED"}
		}
		return nil, &AuthenticationError{http.StatusInternalServerError, "internal database error during authentication", "DATABASE_ERROR"}
	}

	if user == nil {
		return nil, &AuthenticationError{http.StatusUnauthorized, "user account not found or deactivated", "UNAUTHORIZED"}
	}
	if claims.TokenVersion == nil || *claims.TokenVersion != user.TokenVersion {
		return nil, &AuthenticationError{http.StatusUnauthorized, "session revoked; sign in again", "SESSION_REVOKED"}
	}
	return user, nil
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
