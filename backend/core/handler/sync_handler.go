package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/google/uuid"
)

type SyncHandler struct {
	syncService *service.SyncService
}

func NewSyncHandler(syncService *service.SyncService) *SyncHandler {
	return &SyncHandler{syncService: syncService}
}

type BatchImportRequest struct {
	WorkspaceID string                           `json:"workspace_id"`
	Collections []service.ImportCollectionRequest `json:"collections"`
}

// Pull handles delta pull synchronization (Trigger 1: Open app, Trigger 4: Manual sync)
func (h *SyncHandler) Pull(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())

	wsIDStr := r.URL.Query().Get("workspace_id")
	projIDStr := r.URL.Query().Get("project_id")
	sinceStr := r.URL.Query().Get("since")

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

	since := time.Unix(0, 0) // default to epoch if not provided
	if sinceStr != "" {
		if t, err := time.Parse(time.RFC3339Nano, sinceStr); err == nil {
			since = t
		} else if t, err := time.Parse(time.RFC3339, sinceStr); err == nil {
			since = t
		}
	}

	delta, err := h.syncService.PullDelta(r.Context(), user, wsID, projID, since)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, delta)
}

// Push handles batch push of mutations with OCC conflict detection
func (h *SyncHandler) Push(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())

	var req service.SyncPushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	result, err := h.syncService.PushChangeset(r.Context(), user, req)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, result)
}

// ImportBatch handles claiming and migrating offline LocalStorage collections into user's private workspace
func (h *SyncHandler) ImportBatch(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())

	var req BatchImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	wsID, err := uuid.Parse(req.WorkspaceID)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid workspace_id", "BAD_REQUEST")
		return
	}

	if err := h.syncService.ImportBatch(r.Context(), user, wsID, req.Collections); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"message": "offline collections successfully imported into cloud workspace",
	})
}
