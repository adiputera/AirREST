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
		_, _, err := authService.ChangePassword(ctx, uuid.New(), "oldpassword123", "short")
		if err != ErrPasswordTooShort {
			t.Fatalf("expected ErrPasswordTooShort, got: %v", err)
		}
	})

	t.Run("SearchUsers with short or wildcard-only query returns empty list without error", func(t *testing.T) {
		for _, q := range []string{"a", "%%", "__", "%_\\"} {
			results, err := authService.SearchUsers(ctx, q)
			if err != nil {
				t.Fatalf("unexpected error on query %q: %v", q, err)
			}
			if len(results) != 0 {
				t.Fatalf("expected 0 results for query %q, got: %d", q, len(results))
			}
		}
	})

	t.Run("ResetPasswordByAdmin requires minimum 8 characters", func(t *testing.T) {
		err := authService.ResetPasswordByAdmin(ctx, uuid.New(), "short")
		if err != ErrPasswordTooShort {
			t.Fatalf("expected ErrPasswordTooShort, got: %v", err)
		}
	})
}
