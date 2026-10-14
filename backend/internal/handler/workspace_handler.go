package handler

import (
	"encoding/json"
	"net/http"

	"github.com/adiputera/airrest-backend/internal/middleware"
	"github.com/adiputera/airrest-backend/internal/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type WorkspaceHandler struct {
	workspaceService *service.WorkspaceService
}

func NewWorkspaceHandler(workspaceService *service.WorkspaceService) *WorkspaceHandler {
	return &WorkspaceHandler{workspaceService: workspaceService}
}

type WorkspaceRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *WorkspaceHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	workspaces, err := h.workspaceService.List(r.Context(), user)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list workspaces", "SERVER_ERROR")
		return
	}
	response.JSON(w, http.StatusOK, workspaces)
}

func (h *WorkspaceHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	var req WorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	ws, err := h.workspaceService.Create(r.Context(), user, req.Name, req.Description)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}
	response.JSON(w, http.StatusCreated, ws)
}

func (h *WorkspaceHandler) Get(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid workspace id", "BAD_REQUEST")
		return
	}

	ws, err := h.workspaceService.Get(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "workspace not found", "NOT_FOUND")
		return
	}
	response.JSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid workspace id", "BAD_REQUEST")
		return
	}

	var req WorkspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	ws, err := h.workspaceService.Update(r.Context(), user, id, req.Name, req.Description)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}
	response.JSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid workspace id", "BAD_REQUEST")
		return
	}

	if err := h.workspaceService.Delete(r.Context(), user, id); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "workspace deleted successfully"})
}
