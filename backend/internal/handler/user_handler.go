package handler

import (
	"net/http"
	"strings"

	"github.com/adiputera/airrest-backend/internal/service"
	"github.com/adiputera/airrest-backend/pkg/response"
)

type UserHandler struct {
	authService *service.AuthService
}

func NewUserHandler(authService *service.AuthService) *UserHandler {
	return &UserHandler{authService: authService}
}

// Search searches registered users by email or name (minimum 2 characters)
func (h *UserHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("email"))
	if q == "" {
		q = strings.TrimSpace(r.URL.Query().Get("q"))
	}

	if len(q) < 2 {
		response.JSON(w, http.StatusOK, []any{})
		return
	}

	users, err := h.authService.SearchUsers(r.Context(), q)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to search users", "SERVER_ERROR")
		return
	}

	response.JSON(w, http.StatusOK, users)
}
