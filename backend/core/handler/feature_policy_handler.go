package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
)

type FeaturePolicyHandler struct {
	service *service.FeaturePolicyService
}

func NewFeaturePolicyHandler(service *service.FeaturePolicyService) *FeaturePolicyHandler {
	return &FeaturePolicyHandler{service: service}
}

type updateFeaturePolicyRequest struct {
	BaseRevision int64 `json:"base_revision"`
	Flags        struct {
		CollectionMove   *bool `json:"collection.move"`
		CollectionDelete *bool `json:"collection.delete"`
		CollectionExport *bool `json:"collection.export"`
	} `json:"flags"`
}

func (h *FeaturePolicyHandler) Get(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	policy, err := h.service.Get(r.Context())
	if err != nil {
		slog.Error("get feature policy failed", "operation", "get_feature_policy", "duration_ms", time.Since(startedAt).Milliseconds(), "error", err)
		response.Error(w, http.StatusServiceUnavailable, "feature policy unavailable", "FEATURE_POLICY_UNAVAILABLE")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	slog.Info("get feature policy succeeded", "operation", "get_feature_policy", "duration_ms", time.Since(startedAt).Milliseconds())
	response.JSON(w, http.StatusOK, policy)
}

func (h *FeaturePolicyHandler) GetAdmin(w http.ResponseWriter, r *http.Request) {
	h.Get(w, r)
}

func (h *FeaturePolicyHandler) Update(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	actorID, ok := middleware.GetUserIDFromContext(r.Context())
	if !ok {
		response.Error(w, http.StatusUnauthorized, "unauthenticated", "UNAUTHORIZED")
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var req updateFeaturePolicyRequest
	if err := decoder.Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid feature policy request", "BAD_REQUEST")
		return
	}
	if req.BaseRevision < 1 || req.Flags.CollectionMove == nil || req.Flags.CollectionDelete == nil || req.Flags.CollectionExport == nil {
		response.Error(w, http.StatusBadRequest, "base_revision and all feature flags are required", "BAD_REQUEST")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		response.Error(w, http.StatusBadRequest, "invalid feature policy request", "BAD_REQUEST")
		return
	}

	flags := domain.FeatureFlags{
		CollectionMove:   *req.Flags.CollectionMove,
		CollectionDelete: *req.Flags.CollectionDelete,
		CollectionExport: *req.Flags.CollectionExport,
	}
	policy, err := h.service.Update(r.Context(), flags, req.BaseRevision, actorID)
	if errors.Is(err, service.ErrFeaturePolicyConflict) {
		current, getErr := h.service.Get(r.Context())
		if getErr == nil {
			response.Conflict(w, "feature policy was changed by another administrator", current)
			return
		}
		response.Error(w, http.StatusConflict, "feature policy was changed by another administrator", "CONFLICT")
		return
	}
	if errors.Is(err, service.ErrInvalidFeaturePolicy) {
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
		return
	}
	if err != nil {
		slog.Error("update feature policy failed", "operation", "update_feature_policy", "user_id", actorID, "duration_ms", time.Since(startedAt).Milliseconds(), "error", err)
		response.Error(w, http.StatusServiceUnavailable, "feature policy unavailable", "FEATURE_POLICY_UNAVAILABLE")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	slog.Info("update feature policy succeeded", "operation", "update_feature_policy", "user_id", actorID, "revision", policy.Revision, "duration_ms", time.Since(startedAt).Milliseconds())
	response.JSON(w, http.StatusOK, policy)
}
