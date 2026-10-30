package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/google/uuid"
)

type featurePolicyHandlerStore struct {
	policy *domain.FeaturePolicy
}

func (s *featurePolicyHandlerStore) Get(context.Context) (*domain.FeaturePolicy, error) {
	return s.policy, nil
}

func (s *featurePolicyHandlerStore) Update(_ context.Context, flags domain.FeatureFlags, baseRevision int64, actorID uuid.UUID) (*domain.FeaturePolicy, error) {
	s.policy = &domain.FeaturePolicy{
		Flags:     flags,
		Revision:  baseRevision + 1,
		UpdatedBy: &actorID,
		UpdatedAt: time.Now().UTC(),
	}
	return s.policy, nil
}

func TestFeaturePolicyUpdateAcceptsDisabledFlag(t *testing.T) {
	store := &featurePolicyHandlerStore{policy: &domain.FeaturePolicy{Flags: domain.DefaultFeatureFlags(), Revision: 1, UpdatedAt: time.Now().UTC()}}
	h := NewFeaturePolicyHandler(service.NewFeaturePolicyService(store))
	actor := &domain.User{ID: uuid.New(), Role: domain.RoleSuperadmin}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/feature-policy", bytes.NewBufferString(`{
		"base_revision": 1,
		"flags": {"collection.move": false, "collection.delete": true, "collection.export": true}
	}`))
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, actor))
	rr := httptest.NewRecorder()

	h.Update(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if store.policy.Flags.CollectionMove {
		t.Fatal("collection.move should be persisted as disabled")
	}
}

func TestFeaturePolicyUpdateRejectsMissingFlags(t *testing.T) {
	store := &featurePolicyHandlerStore{policy: &domain.FeaturePolicy{Flags: domain.DefaultFeatureFlags(), Revision: 1, UpdatedAt: time.Now().UTC()}}
	h := NewFeaturePolicyHandler(service.NewFeaturePolicyService(store))
	actor := &domain.User{ID: uuid.New(), Role: domain.RoleSuperadmin}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/admin/feature-policy", bytes.NewBufferString(`{
		"base_revision": 1,
		"flags": {"collection.move": false}
	}`))
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, actor))
	rr := httptest.NewRecorder()

	h.Update(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d: %s", rr.Code, rr.Body.String())
	}
	var response struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != "BAD_REQUEST" {
		t.Fatalf("expected BAD_REQUEST, got %q", response.Code)
	}
}
