package app

import (
	"net/http"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
)

type testAuthenticator struct{ user *domain.User }

func (a *testAuthenticator) Authenticate(*http.Request) (*domain.User, *middleware.AuthenticationError) {
	return a.user, nil
}

func TestSelectAuthenticator(t *testing.T) {
	fallback, err := selectAuthenticator(Options{}, nil, nil)
	if err != nil || fallback == nil {
		t.Fatalf("default password authenticator missing: %v", err)
	}

	custom := &testAuthenticator{}
	called := false
	selected, err := selectAuthenticator(Options{AuthenticatorFactory: func(verifier middleware.TokenVerifier, users middleware.UserResolver) middleware.Authenticator {
		called = true
		return custom
	}}, nil, nil)
	if err != nil || !called || selected != custom {
		t.Fatalf("custom authenticator was not selected: %v", err)
	}

	_, err = selectAuthenticator(Options{AuthenticatorFactory: func(middleware.TokenVerifier, middleware.UserResolver) middleware.Authenticator {
		return nil
	}}, nil, nil)
	if err == nil {
		t.Fatal("nil authenticator must fail application assembly")
	}
}
