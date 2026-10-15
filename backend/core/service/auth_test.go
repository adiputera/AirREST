package service

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestAuthServiceValidationRules(t *testing.T) {
	authService := NewAuthService(nil, nil)
	ctx := context.Background()

	t.Run("UpdateProfile requires non-empty name", func(t *testing.T) {
		_, err := authService.UpdateProfile(ctx, uuid.New(), "   ", nil)
		if err != ErrNameRequired {
			t.Fatalf("expected ErrNameRequired, got: %v", err)
		}
	})

	t.Run("ChangePassword requires minimum 8 characters", func(t *testing.T) {
		err := authService.ChangePassword(ctx, uuid.New(), "oldpassword123", "short")
		if err != ErrPasswordTooShort {
			t.Fatalf("expected ErrPasswordTooShort, got: %v", err)
		}
	})

	t.Run("SearchUsers with short query returns empty list without error", func(t *testing.T) {
		results, err := authService.SearchUsers(ctx, "a")
		if err != nil {
			t.Fatalf("unexpected error on short query: %v", err)
		}
		if len(results) != 0 {
			t.Fatalf("expected 0 results for single character query, got: %d", len(results))
		}
	})
}
