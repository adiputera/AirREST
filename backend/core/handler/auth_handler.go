package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
)

type AuthHandler struct {
	authService *service.AuthService
}

func NewAuthHandler(authService *service.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	User         any       `json:"user"`
	Token        string    `json:"token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type RefreshTokenRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// Register handles user registration (disabled in favor of superadmin provisioning)
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	response.Error(w, http.StatusForbidden, "Public registration is disabled. New accounts must be provisioned by a super administrator.", "REGISTRATION_DISABLED")
}

// Login handles user authentication
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	user, tokens, err := h.authService.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			response.Error(w, http.StatusUnauthorized, "invalid email or password", "INVALID_CREDENTIALS")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to authenticate", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, AuthResponse{
		User:         user,
		Token:        tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresAt:    tokens.ExpiresAt,
	})
}

// Refresh handles token refresh using a valid rolling refresh token
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req RefreshTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	if req.RefreshToken == "" {
		response.Error(w, http.StatusBadRequest, "refresh_token is required", "VALIDATION_ERROR")
		return
	}

	user, tokens, err := h.authService.RefreshToken(r.Context(), req.RefreshToken)
	if err != nil {
		response.Error(w, http.StatusUnauthorized, "invalid or expired refresh token", "INVALID_REFRESH_TOKEN")
		return
	}

	response.JSON(w, http.StatusOK, AuthResponse{
		User:         user,
		Token:        tokens.AccessToken,
		RefreshToken: tokens.RefreshToken,
		ExpiresAt:    tokens.ExpiresAt,
	})
}

// Me returns the profile of currently authenticated user
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
		return
	}

	response.JSON(w, http.StatusOK, user)
}

type UpdateProfileRequest struct {
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// UpdateProfile updates the display name and avatar URL of the authenticated user
func (h *AuthHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
		return
	}

	var req UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	updatedUser, err := h.authService.UpdateProfile(r.Context(), user.ID, req.Name, req.AvatarURL)
	if err != nil {
		if errors.Is(err, service.ErrNameRequired) {
			response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to update profile", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, updatedUser)
}

// ChangePassword changes the authenticated user's password after verifying their current password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
		return
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	if err := h.authService.ChangePassword(r.Context(), user.ID, req.CurrentPassword, req.NewPassword); err != nil {
		if errors.Is(err, service.ErrIncorrectCurrentPassword) {
			response.Error(w, http.StatusBadRequest, err.Error(), "INVALID_CURRENT_PASSWORD")
			return
		}
		if errors.Is(err, service.ErrPasswordTooShort) {
			response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to change password", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"message": "password updated successfully",
	})
}

