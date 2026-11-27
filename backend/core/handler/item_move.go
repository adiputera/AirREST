package handler

import (
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

type MoveItemRequest struct {
	SourceCollectionID uuid.UUID  `json:"source_collection_id"`
	TargetCollectionID uuid.UUID  `json:"target_collection_id"`
	TargetParentID     *uuid.UUID `json:"target_parent_id"`
}

func (h *CollectionHandler) MoveItem(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	var req MoveItemRequest
	if err != nil || id == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid item id", "BAD_REQUEST")
		return
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SourceCollectionID == uuid.Nil || req.TargetCollectionID == uuid.Nil {
		response.Error(w, http.StatusBadRequest, "invalid move payload", "BAD_REQUEST")
		return
	}
	err = h.collectionService.MoveItem(r.Context(), middleware.GetUserFromContext(r.Context()), id, req.SourceCollectionID, req.TargetCollectionID, req.TargetParentID)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrForbidden), errors.Is(err, service.ErrReaderCannotModify):
			response.Error(w, http.StatusForbidden, "write access to both collections is required", "FORBIDDEN")
		case errors.Is(err, postgres.ErrCollectionNotFound), errors.Is(err, postgres.ErrItemNotFound):
			response.Error(w, http.StatusNotFound, "item or collection not found", "NOT_FOUND")
		case errors.Is(err, postgres.ErrVersionConflict):
			response.Error(w, http.StatusConflict, "item location or collection access changed; refresh before retrying", "CONFLICT")
		case errors.Is(err, postgres.ErrCollectionItemLimit):
			response.Error(w, http.StatusRequestEntityTooLarge, err.Error(), "LIMIT_EXCEEDED")
		case errors.Is(err, postgres.ErrInvalidItemMove):
			response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		default:
			response.Error(w, http.StatusInternalServerError, "failed to move item", "SERVER_ERROR")
		}
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "item moved successfully"})
}
