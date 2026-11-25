package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrInvalidItemMove = errors.New("invalid item move destination or source")

const maxItemMoveDepth = 32

// MoveItem preserves IDs and changes the entire subtree in one transaction.
// The authorized collection snapshots are checked again under ordered locks.
func (r *CollectionRepository) MoveItem(ctx context.Context, id uuid.UUID, source, target *domain.Collection, parentID *uuid.UUID, userID uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, workspace_id, project_id, min_role FROM collections
		WHERE id = ANY($1) AND deleted_at IS NULL ORDER BY id FOR UPDATE`, []uuid.UUID{source.ID, target.ID})
	if err != nil {
		return err
	}
	count := 0
	for rows.Next() {
		var col domain.Collection
		if err := rows.Scan(&col.ID, &col.WorkspaceID, &col.ProjectID, &col.MinRole); err != nil {
			rows.Close()
			return err
		}
		expected := source
		if col.ID == target.ID {
			expected = target
		}
		if !sameOptionalUUID(col.WorkspaceID, expected.WorkspaceID) || !sameOptionalUUID(col.ProjectID, expected.ProjectID) || col.MinRole != expected.MinRole {
			rows.Close()
			return ErrVersionConflict
		}
		count++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	expectedCount := 2
	if source.ID == target.ID {
		expectedCount = 1
	}
	if count != expectedCount {
		return ErrCollectionNotFound
	}
	var currentCollection uuid.UUID
	var currentParent *uuid.UUID
	err = tx.QueryRow(ctx, `SELECT collection_id, parent_id FROM collection_items WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&currentCollection, &currentParent)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrItemNotFound
	}
	if err != nil {
		return err
	}
	// Repeating an acknowledged cross-collection move is harmless.
	if source.ID != target.ID && currentCollection == target.ID && sameOptionalUUID(currentParent, parentID) {
		return tx.Commit(ctx)
	}
	if currentCollection != source.ID {
		return ErrVersionConflict
	}
	if parentID != nil {
		var valid bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collection_items WHERE id=$1 AND collection_id=$2 AND type='folder' AND deleted_at IS NULL)`, parentID, target.ID).Scan(&valid)
		if err != nil {
			return err
		}
		if !valid {
			return ErrInvalidItemMove
		}
		var cycle bool
		err = tx.QueryRow(ctx, `WITH RECURSIVE subtree AS (
			SELECT id FROM collection_items WHERE id=$1
			UNION SELECT i.id FROM collection_items i JOIN subtree s ON i.parent_id=s.id
		) SELECT EXISTS(SELECT 1 FROM subtree WHERE id=$2)`, id, parentID).Scan(&cycle)
		if err != nil {
			return err
		}
		if cycle {
			return ErrInvalidItemMove
		}
	}
	parentDepth := 0
	if parentID != nil {
		err = tx.QueryRow(ctx, `WITH RECURSIVE ancestors AS (
			SELECT id, parent_id, 1 AS depth FROM collection_items
			WHERE id=$1 AND collection_id=$2 AND deleted_at IS NULL
			UNION ALL
			SELECT ci.id, ci.parent_id, a.depth + 1 FROM collection_items ci
			JOIN ancestors a ON ci.id = a.parent_id
			WHERE ci.collection_id=$2 AND ci.deleted_at IS NULL AND a.depth < $3 + 2
		) SELECT COALESCE(MAX(depth), 0) FROM ancestors`, parentID, target.ID, maxItemMoveDepth).Scan(&parentDepth)
		if err != nil {
			return err
		}
	}
	var subtreeHeight int
	err = tx.QueryRow(ctx, `WITH RECURSIVE subtree AS (
		SELECT id, 1 AS height FROM collection_items
		WHERE id=$1 AND collection_id=$2 AND deleted_at IS NULL
		UNION ALL
		SELECT ci.id, s.height + 1 FROM collection_items ci
		JOIN subtree s ON ci.parent_id = s.id
		WHERE ci.collection_id=$2 AND ci.deleted_at IS NULL AND s.height < $3 + 2
	) SELECT COALESCE(MAX(height), 1) FROM subtree`, id, source.ID, maxItemMoveDepth).Scan(&subtreeHeight)
	if err != nil {
		return err
	}
	if exceedsItemMoveDepth(parentDepth, subtreeHeight) {
		return ErrInvalidItemMove
	}
	now := time.Now().UTC()
	_, err = tx.Exec(ctx, `WITH RECURSIVE subtree AS (
		SELECT id FROM collection_items WHERE id=$1
		UNION SELECT i.id FROM collection_items i JOIN subtree s ON i.parent_id=s.id WHERE i.collection_id=$2
	) UPDATE collection_items SET collection_id=$3,
		parent_id=CASE WHEN id=$1 THEN $4::uuid ELSE parent_id END,
		sort_order=CASE WHEN id=$1 THEN (SELECT COALESCE(MAX(sibling.sort_order), -1)+1 FROM collection_items sibling WHERE sibling.collection_id=$3 AND sibling.parent_id IS NOT DISTINCT FROM $4::uuid AND sibling.deleted_at IS NULL AND sibling.id<>$1) ELSE sort_order END,
		version=version+1, updated_at=$5, last_modified_by=$6
		WHERE id IN (SELECT id FROM subtree)`, id, source.ID, target.ID, parentID, now, userID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE collections SET version=version+1, updated_at=$2, last_modified_by=$3 WHERE id=ANY($1)`, []uuid.UUID{source.ID, target.ID}, now, userID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func exceedsItemMoveDepth(parentDepth, subtreeHeight int) bool {
	return parentDepth+subtreeHeight > maxItemMoveDepth
}

func sameOptionalUUID(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
