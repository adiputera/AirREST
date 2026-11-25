package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type DuplicateHandler struct {
	duplicateService *service.DuplicateService
}

func NewDuplicateHandler(duplicateService *service.DuplicateService) *DuplicateHandler {
	return &DuplicateHandler{duplicateService: duplicateService}
}

type DuplicateCollectionRequest struct {
	TargetWorkspaceID *string `json:"target_workspace_id,omitempty"`
	TargetProjectID   *string `json:"target_project_id,omitempty"`
	OperationID       string  `json:"operation_id"`
}

type ImportDuplicateCollectionRequest struct {
	TargetWorkspaceID *string                                  `json:"target_workspace_id,omitempty"`
	TargetProjectID   *string                                  `json:"target_project_id,omitempty"`
	OperationID       string                                   `json:"operation_id"`
	Collection        service.ImportDuplicateCollectionPayload `json:"collection"`
}

type DuplicateItemRequest struct {
	SourceCollectionID string  `json:"source_collection_id"`
	TargetCollectionID string  `json:"target_collection_id"`
	TargetParentID     *string `json:"target_parent_id,omitempty"`
	OperationID        string  `json:"operation_id"`
}

func parseOptionalUUID(raw *string, field string) (*uuid.UUID, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(*raw)
	if err != nil || id == uuid.Nil {
		return nil, errors.New("invalid " + field)
	}
	return &id, nil
}

func (h *DuplicateHandler) DuplicateCollection(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthorized", "UNAUTHORIZED")
		return
	}

	sourceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || sourceID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid collection id", "BAD_REQUEST")
		return
	}

	var req DuplicateCollectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid duplicate payload", "BAD_REQUEST")
		return
	}

	opID, err := uuid.Parse(req.OperationID)
	if err != nil || opID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid operation_id", "BAD_REQUEST")
		return
	}

	targetWsID, err := parseOptionalUUID(req.TargetWorkspaceID, "target_workspace_id")
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	targetProjID, err := parseOptionalUUID(req.TargetProjectID, "target_project_id")
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	if (targetWsID == nil) == (targetProjID == nil) {
		response.Error(w, http.StatusBadRequest, "exactly one of target_workspace_id or target_project_id is required", "BAD_REQUEST")
		return
	}

	receipt, err := h.duplicateService.DuplicateCollection(r.Context(), user, sourceID, targetWsID, targetProjID, opID)
	if err != nil {
		writeDuplicateError(w, err)
		return
	}

	response.JSON(w, http.StatusCreated, receipt)
}

func (h *DuplicateHandler) ImportDuplicateCollection(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthorized", "UNAUTHORIZED")
		return
	}

	var req ImportDuplicateCollectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid duplicate upload payload", "BAD_REQUEST")
		return
	}

	opID, err := uuid.Parse(req.OperationID)
	if err != nil || opID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid operation_id", "BAD_REQUEST")
		return
	}

	targetWsID, err := parseOptionalUUID(req.TargetWorkspaceID, "target_workspace_id")
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	targetProjID, err := parseOptionalUUID(req.TargetProjectID, "target_project_id")
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	if (targetWsID == nil) == (targetProjID == nil) {
		response.Error(w, http.StatusBadRequest, "exactly one of target_workspace_id or target_project_id is required", "BAD_REQUEST")
		return
	}

	receipt, err := h.duplicateService.ImportDuplicateCollection(r.Context(), user, targetWsID, targetProjID, opID, req.Collection)
	if err != nil {
		writeDuplicateError(w, err)
		return
	}

	response.JSON(w, http.StatusCreated, receipt)
}

func (h *DuplicateHandler) DuplicateItem(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	if user == nil {
		response.Error(w, http.StatusUnauthorized, "unauthorized", "UNAUTHORIZED")
		return
	}

	itemID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || itemID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid item id", "BAD_REQUEST")
		return
	}

	var req DuplicateItemRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid duplicate payload", "BAD_REQUEST")
		return
	}

	opID, err := uuid.Parse(req.OperationID)
	if err != nil || opID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid operation_id", "BAD_REQUEST")
		return
	}
	sourceColID, err := uuid.Parse(req.SourceCollectionID)
	if err != nil || sourceColID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid source_collection_id", "BAD_REQUEST")
		return
	}
	targetColID, err := uuid.Parse(req.TargetCollectionID)
	if err != nil || targetColID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid target_collection_id", "BAD_REQUEST")
		return
	}
	targetParentID, err := parseOptionalUUID(req.TargetParentID, "target_parent_id")
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}

	receipt, err := h.duplicateService.DuplicateItem(r.Context(), user, itemID, sourceColID, targetColID, targetParentID, opID)
	if err != nil {
		writeDuplicateError(w, err)
		return
	}

	response.JSON(w, http.StatusCreated, receipt)
}

func writeDuplicateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidItemPayload), errors.Is(err, postgres.ErrDuplicateValidation):
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
	case errors.Is(err, postgres.ErrDuplicateForbidden), errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrReaderCannotModify):
		response.Error(w, http.StatusForbidden, err.Error(), "FORBIDDEN")
	case errors.Is(err, postgres.ErrDuplicateNotFound), errors.Is(err, postgres.ErrCollectionNotFound), errors.Is(err, postgres.ErrItemNotFound):
		response.Error(w, http.StatusNotFound, err.Error(), "NOT_FOUND")
	case errors.Is(err, postgres.ErrDuplicateConflict), errors.Is(err, postgres.ErrVersionConflict):
		response.Error(w, http.StatusConflict, err.Error(), "CONFLICT")
	case errors.Is(err, postgres.ErrDuplicateLimit), errors.Is(err, service.ErrBatchLimit), errors.Is(err, service.ErrExampleLimitExceeded):
		response.Error(w, http.StatusRequestEntityTooLarge, err.Error(), "DUPLICATE_LIMIT_EXCEEDED")
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		response.Error(w, http.StatusServiceUnavailable, "request deadline exceeded", "REQUEST_TIMEOUT")
	default:
		response.Error(w, http.StatusInternalServerError, "duplicate operation failed", "SERVER_ERROR")
	}
}
