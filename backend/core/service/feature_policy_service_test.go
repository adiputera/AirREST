package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

type fakeFeaturePolicyStore struct {
	policy *domain.FeaturePolicy
	err    error
}

func (s *fakeFeaturePolicyStore) Get(context.Context) (*domain.FeaturePolicy, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.policy, nil
}

func (s *fakeFeaturePolicyStore) Update(_ context.Context, flags domain.FeatureFlags, baseRevision int64, actorID uuid.UUID) (*domain.FeaturePolicy, error) {
	if s.err != nil {
		return nil, s.err
	}
	if s.policy == nil || s.policy.Revision != baseRevision {
		return nil, postgres.ErrFeaturePolicyConflict
	}
	s.policy = &domain.FeaturePolicy{Flags: flags, Revision: baseRevision + 1, UpdatedBy: &actorID, UpdatedAt: time.Now().UTC()}
	return s.policy, nil
}

func TestFeaturePolicyServiceRequireEnabled(t *testing.T) {
	tests := []struct {
		name    string
		flags   domain.FeatureFlags
		feature string
		wantErr error
	}{
		{name: "allows enabled collection delete", flags: domain.DefaultFeatureFlags(), feature: domain.FeatureCollectionDelete},
		{name: "rejects disabled collection move", flags: domain.FeatureFlags{CollectionDelete: true, CollectionExport: true}, feature: domain.FeatureCollectionMove, wantErr: ErrFeatureDisabled},
		{name: "rejects unknown feature", flags: domain.DefaultFeatureFlags(), feature: "unknown", wantErr: ErrFeatureDisabled},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Arrange
			store := &fakeFeaturePolicyStore{policy: &domain.FeaturePolicy{Flags: tt.flags, Revision: 1}}
			service := NewFeaturePolicyService(store)

			// Act
			err := service.RequireEnabled(context.Background(), tt.feature)

			// Assert
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("RequireEnabled() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestFeaturePolicyServiceFailsClosedWhenStoreUnavailable(t *testing.T) {
	// Arrange
	service := NewFeaturePolicyService(&fakeFeaturePolicyStore{err: errors.New("database unavailable")})

	// Act
	err := service.RequireEnabled(context.Background(), domain.FeatureCollectionDelete)

	// Assert
	if !errors.Is(err, ErrFeaturePolicyUnavailable) {
		t.Fatalf("RequireEnabled() error = %v, want ErrFeaturePolicyUnavailable", err)
	}
}
