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

type EnvironmentHandler struct {
	envService *service.EnvironmentService
}

func NewEnvironmentHandler(envService *service.EnvironmentService) *EnvironmentHandler {
	return &EnvironmentHandler{envService: envService}
}

type CreateEnvironmentRequest struct {
	WorkspaceID *string          `json:"workspace_id,omitempty"`
	ProjectID   *string          `json:"project_id,omitempty"`
	Name        string           `json:"name"`
	Variables   *json.RawMessage `json:"variables"`
}

type UpdateEnvironmentRequest struct {
	Name        string           `json:"name"`
	Variables   *json.RawMessage `json:"variables"`
	BaseVersion int64            `json:"base_version"`
}

func (h *EnvironmentHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())

	wsIDStr := r.URL.Query().Get("workspace_id")
	projIDStr := r.URL.Query().Get("project_id")

	var wsID, projID *uuid.UUID
	if wsIDStr != "" {
		if id, err := uuid.Parse(wsIDStr); err == nil {
			wsID = &id
		}
	}
	if projIDStr != "" {
		if id, err := uuid.Parse(projIDStr); err == nil {
			projID = &id
		}
	}

	envs, err := h.envService.List(r.Context(), user, wsID, projID)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, envs)
}

func (h *EnvironmentHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	var req CreateEnvironmentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	var wsID, projID *uuid.UUID
	if req.WorkspaceID != nil && *req.WorkspaceID != "" {
		id, err := uuid.Parse(*req.WorkspaceID)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "invalid workspace_id", "BAD_REQUEST")
			return
		}
		wsID = &id
	}
	if req.ProjectID != nil && *req.ProjectID != "" {
		id, err := uuid.Parse(*req.ProjectID)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "invalid project_id", "BAD_REQUEST")
			return
		}
		projID = &id
	}

	env := &domain.Environment{
		WorkspaceID: wsID,
		ProjectID:   projID,
		Name:        req.Name,
		Variables:   req.Variables,
	}

	if err := h.envService.Create(r.Context(), user, env); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusCreated, env)
}

func (h *EnvironmentHandler) Get(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid environment id", "BAD_REQUEST")
		return
	}

	env, err := h.envService.Get(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "environment not found", "NOT_FOUND")
		return
	}

	response.JSON(w, http.StatusOK, env)
}

func (h *EnvironmentHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid environment id", "BAD_REQUEST")
		return
	}

	var req UpdateEnvironmentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	env := &domain.Environment{
		ID:        id,
		Name:      req.Name,
		Variables: req.Variables,
	}

	updated, err := h.envService.Update(r.Context(), user, env, req.BaseVersion)
	if err != nil {
		if errors.Is(err, postgres.ErrVersionConflict) {
			response.Conflict(w, "conflict: environment has been modified by another user", updated)
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, updated)
}

func (h *EnvironmentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid environment id", "BAD_REQUEST")
		return
	}

	if err := h.envService.Delete(r.Context(), user, id); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{"message": "environment deleted successfully"})
}
