package token

import (
	"github.com/golang-jwt/jwt/v5"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestTokenManagerGenerateAndValidate(t *testing.T) {
	secret := "test-secret-key-that-is-at-least-32-bytes-long"
	tm := NewTokenManager(secret, 24)

	userID := uuid.New()
	email := "test@example.com"
	role := "superadmin"

	tokenStr, expiresAt, err := tm.GenerateToken(userID, email, role, 0)
	if err != nil {
		t.Fatalf("failed to generate token: %v", err)
	}

	if tokenStr == "" {
		t.Fatal("expected non-empty token string")
	}

	if expiresAt.Before(time.Now()) {
		t.Fatal("expected expiration to be in the future")
	}

	claims, err := tm.ValidateToken(tokenStr)
	if err != nil {
		t.Fatalf("failed to validate token: %v", err)
	}

	if claims.UserID != userID {
		t.Errorf("expected userID %v, got %v", userID, claims.UserID)
	}
	if claims.Email != email {
		t.Errorf("expected email %s, got %s", email, claims.Email)
	}
	if claims.Role != role {
		t.Errorf("expected role %s, got %s", role, claims.Role)
	}
}

func TestTokenManagerInvalidToken(t *testing.T) {
	tm := NewTokenManager("secret-one-at-least-32-bytes-long", 24)
	tmDifferent := NewTokenManager("secret-two-at-least-32-bytes-long", 24)

	userID := uuid.New()
	tokenStr, _, _ := tm.GenerateToken(userID, "test@example.com", "user", 0)

	// Validate with different secret
	_, err := tmDifferent.ValidateToken(tokenStr)
	if err == nil {
		t.Fatal("expected error validating token with mismatched secret, got nil")
	}

	// Validate tampered token
	_, err = tm.ValidateToken(tokenStr + "corrupted")
	if err == nil {
		t.Fatal("expected error validating corrupted token, got nil")
	}
}

func TestTokenManagerRefreshTokenLifecycle(t *testing.T) {
	secret := "test-secret-key-that-is-at-least-32-bytes-long"
	tm := NewTokenManager(secret, 24, 30)

	userID := uuid.New()
	email := "refresh-user@example.com"
	role := "admin"

	accessToken, _, err := tm.GenerateToken(userID, email, role, 0)
	if err != nil {
		t.Fatalf("failed to generate access token: %v", err)
	}

	refreshToken, refreshExpiresAt, err := tm.GenerateRefreshToken(userID, email, role, 0)
	if err != nil {
		t.Fatalf("failed to generate refresh token: %v", err)
	}

	if refreshExpiresAt.Before(time.Now().Add(29 * 24 * time.Hour)) {
		t.Fatal("expected refresh token to expire around 30 days in future")
	}

	// 1. Validate refresh token succeeds
	refreshClaims, err := tm.ValidateRefreshToken(refreshToken)
	if err != nil {
		t.Fatalf("failed to validate valid refresh token: %v", err)
	}
	if refreshClaims.UserID != userID || refreshClaims.Email != email || refreshClaims.Role != role {
		t.Errorf("mismatched refresh claims: got %+v", refreshClaims)
	}

	// 2. Validate isolation: Refresh Token CANNOT be used as Access Token
	_, err = tm.ValidateToken(refreshToken)
	if err == nil {
		t.Fatal("expected ValidateToken to reject a refresh token, got nil")
	}

	// 3. Validate isolation: Access Token CANNOT be used as Refresh Token
	_, err = tm.ValidateRefreshToken(accessToken)
	if err == nil {
		t.Fatal("expected ValidateRefreshToken to reject an access token, got nil")
	}
}

func TestRejectsLegacyAndMalformedSessionClaims(t *testing.T) {
	tm := NewTokenManager("test-session-signing-key", 1)
	for _, tokenType := range []TokenType{TokenTypeAccess, TokenTypeRefresh} {
		for _, version := range []*int64{nil, new(int64(-1))} {
			claims := CustomClaims{UserID: uuid.New(), TokenType: tokenType, TokenVersion: version, RegisteredClaims: jwt.RegisteredClaims{Issuer: "airrest-api", ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}
			signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(tm.secret)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tm.ValidateToken(signed); err == nil {
				t.Fatal("accepted legacy/invalid access token")
			}
			if _, err := tm.ValidateRefreshToken(signed); err == nil {
				t.Fatal("accepted legacy/invalid refresh token")
			}
		}
	}
	signed, _, err := tm.GenerateToken(uuid.New(), "tester@example.com", "user", 0)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := tm.ValidateToken(signed)
	if err != nil {
		t.Fatal(err)
	}
	if claims.TokenVersion == nil || *claims.TokenVersion != 0 {
		t.Fatal("explicit zero version must be accepted")
	}
}
