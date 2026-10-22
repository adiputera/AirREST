package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type AdminHandler struct {
	authService *service.AuthService
}

func NewAdminHandler(authService *service.AuthService) *AdminHandler {
	return &AdminHandler{authService: authService}
}

type AdminCreateUserRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	Role     string `json:"role"` // 'superadmin' or 'user'
}

type AdminResetPasswordRequest struct {
	Password string `json:"password"`
}

// ListUsers lists all registered users in the platform
func (h *AdminHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.authService.ListUsers(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list users", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, users)
}

// CreateUser allows superadmin to provision new accounts with custom roles
func (h *AdminHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req AdminCreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	systemRole := domain.RoleUser
	if req.Role == string(domain.RoleSuperadmin) {
		systemRole = domain.RoleSuperadmin
	}

	user, err := h.authService.CreateUserByAdmin(r.Context(), req.Email, req.Password, req.Name, systemRole)
	if err != nil {
		if errors.Is(err, service.ErrEmailAlreadyExists) {
			response.Error(w, http.StatusConflict, err.Error(), "EMAIL_EXISTS")
			return
		}
		if errors.Is(err, service.ErrPasswordTooShort) {
			response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to provision user", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusCreated, user)
}

// ResetUserPassword allows superadmin to reset another user's password without knowing old password
func (h *AdminHandler) ResetUserPassword(w http.ResponseWriter, r *http.Request) {
	userIdStr := chi.URLParam(r, "userId")
	targetUserID, err := uuid.Parse(userIdStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	var req AdminResetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	if err := h.authService.ResetPasswordByAdmin(r.Context(), targetUserID, req.Password); err != nil {
		if errors.Is(err, service.ErrPasswordTooShort) {
			response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
			return
		}
		if errors.Is(err, postgres.ErrUserNotFound) {
			response.Error(w, http.StatusNotFound, "user not found", "NOT_FOUND")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to reset user password", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{"message": "user password reset successfully"})
}

// DeleteUser allows superadmin to permanently remove a user account
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	adminID, ok := middleware.GetUserIDFromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
		return
	}

	userIdStr := chi.URLParam(r, "userId")
	targetUserID, err := uuid.Parse(userIdStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	if err := h.authService.DeleteUserByAdmin(r.Context(), adminID, targetUserID); err != nil {
		if errors.Is(err, service.ErrCannotDeleteSelf) {
			response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
			return
		}
		if errors.Is(err, service.ErrCannotDeleteLastAdmin) {
			response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
			return
		}
		if errors.Is(err, postgres.ErrUserNotFound) {
			response.Error(w, http.StatusNotFound, "user not found", "NOT_FOUND")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to delete user: "+err.Error(), "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{"message": "user deleted successfully"})
}

