package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

var (
	ErrFeatureDisabled          = errors.New("operation disabled by feature policy")
	ErrFeaturePolicyUnavailable = errors.New("feature policy unavailable")
	ErrFeaturePolicyConflict    = errors.New("feature policy revision conflict")
	ErrInvalidFeaturePolicy     = errors.New("invalid feature policy")
)

type featurePolicyStore interface {
	Get(ctx context.Context) (*domain.FeaturePolicy, error)
	Update(ctx context.Context, flags domain.FeatureFlags, baseRevision int64, actorID uuid.UUID) (*domain.FeaturePolicy, error)
}

type FeaturePolicyService struct {
	store featurePolicyStore
}

func NewFeaturePolicyService(store featurePolicyStore) *FeaturePolicyService {
	return &FeaturePolicyService{store: store}
}

func (s *FeaturePolicyService) Get(ctx context.Context) (*domain.FeaturePolicy, error) {
	if s == nil || s.store == nil {
		return nil, ErrFeaturePolicyUnavailable
	}
	policy, err := s.store.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFeaturePolicyUnavailable, err)
	}
	return policy, nil
}

func (s *FeaturePolicyService) Update(ctx context.Context, flags domain.FeatureFlags, baseRevision int64, actorID uuid.UUID) (*domain.FeaturePolicy, error) {
	if baseRevision < 1 || actorID == uuid.Nil {
		return nil, ErrInvalidFeaturePolicy
	}
	if s == nil || s.store == nil {
		return nil, ErrFeaturePolicyUnavailable
	}
	policy, err := s.store.Update(ctx, flags, baseRevision, actorID)
	if errors.Is(err, postgres.ErrFeaturePolicyConflict) {
		return nil, ErrFeaturePolicyConflict
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFeaturePolicyUnavailable, err)
	}
	return policy, nil
}

func (s *FeaturePolicyService) RequireEnabled(ctx context.Context, feature string) error {
	policy, err := s.Get(ctx)
	if err != nil {
		return err
	}
	if !policy.Flags.IsEnabled(feature) {
		return ErrFeatureDisabled
	}
	return nil
}
