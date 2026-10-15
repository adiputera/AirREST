package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
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
