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

type CollectionHandler struct {
	collectionService *service.CollectionService
}

func NewCollectionHandler(collectionService *service.CollectionService) *CollectionHandler {
	return &CollectionHandler{collectionService: collectionService}
}

type CreateCollectionRequest struct {
	WorkspaceID *string `json:"workspace_id,omitempty"`
	ProjectID   *string `json:"project_id,omitempty"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	MinRole     *string `json:"min_role,omitempty"`
}

type UpdateCollectionRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	MinRole     *string `json:"min_role,omitempty"`
	BaseVersion int64   `json:"base_version"`
}

type MoveCollectionRequest struct {
	TargetWorkspaceID *string `json:"target_workspace_id,omitempty"`
	TargetProjectID   *string `json:"target_project_id,omitempty"`
}

func (h *CollectionHandler) List(w http.ResponseWriter, r *http.Request) {
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

	includeItems := r.URL.Query().Get("include_items") == "true"

	collections, err := h.collectionService.ListCollections(r.Context(), user, wsID, projID, includeItems)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, collections)
}

func (h *CollectionHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	var req CreateCollectionRequest
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

	minRole := domain.ProjectRoleReader
	if req.MinRole != nil && *req.MinRole != "" {
		minRole = domain.ProjectRole(*req.MinRole)
	}

	col := &domain.Collection{
		WorkspaceID: wsID,
		ProjectID:   projID,
		Name:        req.Name,
		Description: req.Description,
		MinRole:     minRole,
	}

	if err := h.collectionService.CreateCollection(r.Context(), user, col); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusCreated, col)
}

func (h *CollectionHandler) Get(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	col, err := h.collectionService.GetCollection(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "collection not found", "NOT_FOUND")
		return
	}

	response.JSON(w, http.StatusOK, col)
}

func (h *CollectionHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	var req UpdateCollectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	col := &domain.Collection{
		ID:          id,
		Name:        req.Name,
		Description: req.Description,
	}
	if req.MinRole != nil && *req.MinRole != "" {
		col.MinRole = domain.ProjectRole(*req.MinRole)
	}

	updated, err := h.collectionService.UpdateCollection(r.Context(), user, col, req.BaseVersion)
	if err != nil {
		if errors.Is(err, postgres.ErrVersionConflict) {
			response.Conflict(w, "conflict: collection has been modified by another user", updated)
			return
		}
		if errors.Is(err, postgres.ErrCollectionNotFound) {
			response.Error(w, http.StatusNotFound, "collection not found", "NOT_FOUND")
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, updated)
}

func (h *CollectionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	if err := h.collectionService.DeleteCollection(r.Context(), user, id); err != nil {
		if errors.Is(err, service.ErrFeatureDisabled) {
			response.Error(w, http.StatusForbidden, err.Error(), "FEATURE_DISABLED")
			return
		}
		if errors.Is(err, service.ErrFeaturePolicyUnavailable) {
			response.Error(w, http.StatusServiceUnavailable, "feature policy unavailable", "FEATURE_POLICY_UNAVAILABLE")
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{"message": "collection deleted successfully"})
}

func (h *CollectionHandler) Move(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	var req MoveCollectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	var targetWsID, targetProjID *uuid.UUID
	if req.TargetWorkspaceID != nil && *req.TargetWorkspaceID != "" {
		parsed, err := uuid.Parse(*req.TargetWorkspaceID)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "invalid target_workspace_id", "BAD_REQUEST")
			return
		}
		targetWsID = &parsed
	}
	if req.TargetProjectID != nil && *req.TargetProjectID != "" {
		parsed, err := uuid.Parse(*req.TargetProjectID)
		if err != nil {
			response.Error(w, http.StatusBadRequest, "invalid target_project_id", "BAD_REQUEST")
			return
		}
		targetProjID = &parsed
	}

	if err := h.collectionService.MoveCollection(r.Context(), user, id, targetWsID, targetProjID); err != nil {
		if errors.Is(err, service.ErrFeatureDisabled) {
			response.Error(w, http.StatusForbidden, err.Error(), "FEATURE_DISABLED")
			return
		}
		if errors.Is(err, service.ErrFeaturePolicyUnavailable) {
			response.Error(w, http.StatusServiceUnavailable, "feature policy unavailable", "FEATURE_POLICY_UNAVAILABLE")
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"message": "collection moved successfully",
	})
}

// Item Handlers
func (h *CollectionHandler) CreateItem(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	var item domain.CollectionItem
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	if err := h.collectionService.CreateItem(r.Context(), user, &item); err != nil {
		if errors.Is(err, service.ErrInvalidItemPayload) {
			response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusCreated, item)
}

type UpdateItemRequest struct {
	Item        domain.CollectionItem `json:"item"`
	BaseVersion int64                 `json:"base_version"`
}

func (h *CollectionHandler) UpdateItem(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid item id", "BAD_REQUEST")
		return
	}

	var req UpdateItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	req.Item.ID = id
	updated, err := h.collectionService.UpdateItem(r.Context(), user, &req.Item, req.BaseVersion)
	if err != nil {
		if errors.Is(err, service.ErrInvalidItemPayload) {
			response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
			return
		}
		if errors.Is(err, postgres.ErrVersionConflict) {
			response.Conflict(w, "conflict: item has been modified by another user", updated)
			return
		}
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, updated)
}

func (h *CollectionHandler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid item id", "BAD_REQUEST")
		return
	}

	if err := h.collectionService.DeleteItem(r.Context(), user, id); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{"message": "item deleted successfully"})
}

func (h *CollectionHandler) GetItem(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid item id", "BAD_REQUEST")
		return
	}

	item, err := h.collectionService.GetItem(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "item not found", "NOT_FOUND")
		return
	}

	response.JSON(w, http.StatusOK, item)
}

type ReorderItemsRequest struct {
	Items []domain.ReorderItemPosition `json:"items"`
}

// ReorderItems handles batch item position and folder hierarchy updates within a collection
func (h *CollectionHandler) ReorderItems(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	colIDStr := chi.URLParam(r, "id")
	colID, err := uuid.Parse(colIDStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	var req ReorderItemsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	updatedItems, err := h.collectionService.ReorderItems(r.Context(), user, colID, req.Items)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]any{
		"message": "items reordered successfully",
		"items":   updatedItems,
	})
}
