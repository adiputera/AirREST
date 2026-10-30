package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrFeaturePolicyNotFound = errors.New("feature policy not found")
	ErrFeaturePolicyConflict = errors.New("feature policy revision conflict")
)

type FeaturePolicyRepository struct {
	pool *pgxpool.Pool
}

func NewFeaturePolicyRepository(pool *pgxpool.Pool) *FeaturePolicyRepository {
	return &FeaturePolicyRepository{pool: pool}
}

func (r *FeaturePolicyRepository) Get(ctx context.Context) (*domain.FeaturePolicy, error) {
	const query = `
		SELECT collection_move_enabled, collection_delete_enabled, collection_export_enabled,
		       revision, updated_by, updated_at
		FROM feature_policies
		WHERE singleton = TRUE
	`

	var policy domain.FeaturePolicy
	err := r.pool.QueryRow(ctx, query).Scan(
		&policy.Flags.CollectionMove,
		&policy.Flags.CollectionDelete,
		&policy.Flags.CollectionExport,
		&policy.Revision,
		&policy.UpdatedBy,
		&policy.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrFeaturePolicyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get feature policy: %w", err)
	}
	return &policy, nil
}

func (r *FeaturePolicyRepository) Update(ctx context.Context, flags domain.FeatureFlags, baseRevision int64, actorID uuid.UUID) (*domain.FeaturePolicy, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin feature policy update: %w", err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(ctx); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			slog.Error("feature policy update rollback failed", "operation", "update_feature_policy", "error", rollbackErr)
		}
	}()

	const updateQuery = `
		UPDATE feature_policies
		SET collection_move_enabled = $1,
		    collection_delete_enabled = $2,
		    collection_export_enabled = $3,
		    revision = revision + 1,
		    updated_by = $4,
		    updated_at = $5
		WHERE singleton = TRUE AND revision = $6
		RETURNING revision, updated_at
	`
	now := time.Now().UTC()
	policy := &domain.FeaturePolicy{
		Flags:     flags,
		UpdatedBy: &actorID,
	}
	err = tx.QueryRow(ctx, updateQuery,
		flags.CollectionMove,
		flags.CollectionDelete,
		flags.CollectionExport,
		actorID,
		now,
		baseRevision,
	).Scan(&policy.Revision, &policy.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrFeaturePolicyConflict
	}
	if err != nil {
		return nil, fmt.Errorf("update feature policy: %w", err)
	}

	const auditQuery = `
		INSERT INTO feature_policy_audit (
			revision, collection_move_enabled, collection_delete_enabled, collection_export_enabled, updated_by, created_at
		) VALUES ($1, $2, $3, $4, $5, $6)
	`
	if _, err := tx.Exec(ctx, auditQuery,
		policy.Revision,
		flags.CollectionMove,
		flags.CollectionDelete,
		flags.CollectionExport,
		actorID,
		now,
	); err != nil {
		return nil, fmt.Errorf("audit feature policy update: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit feature policy update: %w", err)
	}
	return policy, nil
}
