package token

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var (
	ErrInvalidToken        = errors.New("invalid or expired token")
	ErrInvalidRefreshToken = errors.New("invalid or expired refresh token")
)

type TokenType string

const (
	TokenTypeAccess  TokenType = "access"
	TokenTypeRefresh TokenType = "refresh"
)

type CustomClaims struct {
	TokenVersion *int64    `json:"token_version"`
	UserID       uuid.UUID `json:"user_id"`
	Email        string    `json:"email"`
	Role         string    `json:"role"`
	TokenType    TokenType `json:"token_type,omitempty"`
	jwt.RegisteredClaims
}

type TokenManager struct {
	secret                []byte
	accessExpirationHours int
	refreshExpirationDays int
}

func NewTokenManager(secret string, accessExpirationHours int, refreshExpirationDays ...int) *TokenManager {
	refDays := 30
	if len(refreshExpirationDays) > 0 && refreshExpirationDays[0] > 0 {
		refDays = refreshExpirationDays[0]
	}
	return &TokenManager{
		secret:                []byte(secret),
		accessExpirationHours: accessExpirationHours,
		refreshExpirationDays: refDays,
	}
}

// GenerateToken generates a signed access JWT string for a user
func (tm *TokenManager) GenerateToken(userID uuid.UUID, email, role string, version int64) (string, time.Time, error) {
	expirationTime := time.Now().Add(time.Duration(tm.accessExpirationHours) * time.Hour)

	claims := &CustomClaims{
		TokenVersion: &version,
		UserID:       userID,
		Email:        email,
		Role:         role,
		TokenType:    TokenTypeAccess,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expirationTime),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "airrest-api",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(tm.secret)
	if err != nil {
		return "", time.Time{}, err
	}

	return tokenString, expirationTime, nil
}

// GenerateRefreshToken generates a rolling refresh JWT string for a user
func (tm *TokenManager) GenerateRefreshToken(userID uuid.UUID, email, role string, version int64) (string, time.Time, error) {
	expirationTime := time.Now().Add(time.Duration(tm.refreshExpirationDays) * 24 * time.Hour)

	claims := &CustomClaims{
		TokenVersion: &version,
		UserID:       userID,
		Email:        email,
		Role:         role,
		TokenType:    TokenTypeRefresh,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expirationTime),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "airrest-api",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(tm.secret)
	if err != nil {
		return "", time.Time{}, err
	}

	return tokenString, expirationTime, nil
}

// ValidateToken parses and validates an access JWT string
func (tm *TokenManager) ValidateToken(tokenString string) (*CustomClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return tm.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("airrest-api"), jwt.WithExpirationRequired())

	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*CustomClaims)
	if !ok || !token.Valid || claims.TokenVersion == nil || *claims.TokenVersion < 0 {
		return nil, ErrInvalidToken
	}

	// Refresh token cannot be used as an access token
	if claims.TokenType != TokenTypeAccess {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// ValidateRefreshToken parses and validates a refresh JWT string
func (tm *TokenManager) ValidateRefreshToken(tokenString string) (*CustomClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidRefreshToken
		}
		return tm.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("airrest-api"), jwt.WithExpirationRequired())

	if err != nil {
		return nil, ErrInvalidRefreshToken
	}

	claims, ok := token.Claims.(*CustomClaims)
	if !ok || !token.Valid || claims.TokenVersion == nil || *claims.TokenVersion < 0 {
		return nil, ErrInvalidRefreshToken
	}

	if claims.TokenType != TokenTypeRefresh {
		return nil, ErrInvalidRefreshToken
	}

	return claims, nil
}
