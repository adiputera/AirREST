package postgres

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ReplaceCollectionReceipt struct {
	OperationID  uuid.UUID `json:"operation_id"`
	Status       string    `json:"status"`
	CollectionID uuid.UUID `json:"collection_id"`
	Version      int64     `json:"version"`
	ItemCount    int       `json:"item_count"`
}

type CollectionExampleRawRow struct {
	ItemID      uuid.UUID
	SortOrder   int
	CreatedAt   time.Time
	ItemVersion int64
	Examples    domain.OptionalRawJSON
}

type CollectionExamplesCursor struct {
	SortOrder int       `json:"s"`
	CreatedAt time.Time `json:"c"`
	ID        uuid.UUID `json:"i"`
}

type ReplaceFlatItem struct {
	ID                 uuid.UUID
	ParentID           *uuid.UUID
	Type               domain.ItemType
	Name               string
	SortOrder          int
	Method             *string
	URL                *string
	Params             *json.RawMessage
	PathVariables      *json.RawMessage
	Headers            *json.RawMessage
	Auth               *json.RawMessage
	BodyType           *string
	RawType            *string
	BodyContent        *string
	GraphQLQuery       *string
	GraphQLVariables   *string
	BodyFormData       *json.RawMessage
	PreRequestScript   *string
	PostResponseScript *string
	Examples           json.RawMessage
}

func EncodeExamplesCursor(c CollectionExamplesCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeExamplesCursor(raw string) (*CollectionExamplesCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid cursor")
	}
	var c CollectionExamplesCursor
	if err := json.Unmarshal(b, &c); err != nil || c.ID == uuid.Nil {
		return nil, fmt.Errorf("invalid cursor")
	}
	return &c, nil
}

// PatchItemExamples atomically mutates one item's examples column inside a transaction with durable operation receipts.
func (r *CollectionRepository) PatchItemExamples(
	ctx context.Context,
	actorID uuid.UUID,
	itemID uuid.UUID,
	operationID uuid.UUID,
	op string,
	fingerprint string,
	baseVersion int64,
	mutate func(itemType domain.ItemType, current domain.OptionalRawJSON) (json.RawMessage, error),
	finalize func(item *domain.CollectionItem),
) (*domain.CollectionItem, error) {
	var outItem *domain.CollectionItem

	for attempt := 0; attempt < 3; attempt++ {
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to begin transaction: %w", err)
		}

		// 1. Check idempotency receipt ledger first
		var existingFP string
		var existingResp json.RawMessage
		err = tx.QueryRow(ctx, `
			SELECT fingerprint, response_json
			FROM item_example_operations
			WHERE actor_id = $1 AND operation_id = $2
			FOR UPDATE
		`, actorID, operationID).Scan(&existingFP, &existingResp)
		if err == nil {
			if existingFP != fingerprint {
				tx.Rollback(ctx)
				return nil, ErrVersionConflict
			}
			var replayed domain.CollectionItem
			if unmarshalErr := json.Unmarshal(existingResp, &replayed); unmarshalErr != nil {
				tx.Rollback(ctx)
				return nil, fmt.Errorf("failed to decode cached example receipt: %w", unmarshalErr)
			}
			replayed.Examples.Present = true
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, commitErr
			}
			return &replayed, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("failed to query example receipt: %w", err)
		}

		// 2. Peek parent collection ID so lock ordering stays collections -> collection_items
		var peekColID uuid.UUID
		err = tx.QueryRow(ctx, `SELECT collection_id FROM collection_items WHERE id = $1 AND deleted_at IS NULL`, itemID).Scan(&peekColID)
		if err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrItemNotFound
			}
			return nil, fmt.Errorf("failed to inspect item: %w", err)
		}

		// 3. Lock parent collection row first
		var colDeletedAt *time.Time
		err = tx.QueryRow(ctx, `SELECT deleted_at FROM collections WHERE id = $1 FOR UPDATE`, peekColID).Scan(&colDeletedAt)
		if err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrCollectionNotFound
			}
			return nil, fmt.Errorf("failed to lock collection: %w", err)
		}
		if colDeletedAt != nil {
			tx.Rollback(ctx)
			return nil, ErrCollectionNotFound
		}

		// 4. Lock item row second
		var item domain.CollectionItem
		var typeStr string
		err = tx.QueryRow(ctx, `
			SELECT id, collection_id, parent_id, type, name, sort_order,
			       method, url, params, path_variables, headers, auth, body_type, raw_type,
			       body_content, graphql_query, graphql_variables, body_form_data,
			       pre_request_script, post_response_script, examples, version, last_modified_by,
			       created_at, updated_at, deleted_at
			FROM collection_items
			WHERE id = $1
			FOR UPDATE
		`, itemID).Scan(
			&item.ID, &item.CollectionID, &item.ParentID, &typeStr, &item.Name, &item.SortOrder,
			&item.Method, &item.URL, &item.Params, &item.PathVariables, &item.Headers, &item.Auth, &item.BodyType, &item.RawType,
			&item.BodyContent, &item.GraphQLQuery, &item.GraphQLVariables, &item.BodyFormData,
			&item.PreRequestScript, &item.PostResponseScript, &item.Examples, &item.Version, &item.LastModifiedBy,
			&item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
		)
		if err != nil {
			tx.Rollback(ctx)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrItemNotFound
			}
			return nil, fmt.Errorf("failed to lock item: %w", err)
		}
		item.Type = domain.ItemType(typeStr)
		if item.DeletedAt != nil {
			tx.Rollback(ctx)
			return nil, ErrItemNotFound
		}
		if item.CollectionID != peekColID {
			tx.Rollback(ctx)
			continue
		}

		if finalize != nil {
			finalize(&item)
		}

		if item.Version != baseVersion {
			tx.Rollback(ctx)
			return &item, ErrVersionConflict
		}

		updatedExamplesRaw, mutateErr := mutate(item.Type, item.Examples)
		if mutateErr != nil {
			tx.Rollback(ctx)
			return &item, mutateErr
		}

		now := time.Now().UTC()
		if _, err := tx.Exec(ctx, `
			UPDATE collections
			SET updated_at = $1, last_modified_by = $2, version = version + 1
			WHERE id = $3 AND deleted_at IS NULL
		`, now, actorID, item.CollectionID); err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("failed to touch parent collection version: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			UPDATE collection_items
			SET examples = $1::jsonb, version = version + 1, updated_at = $2, last_modified_by = $3
			WHERE id = $4 AND deleted_at IS NULL
		`, string(updatedExamplesRaw), now, actorID, item.ID); err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("failed to update saved examples: %w", err)
		}

		item.Examples = domain.NewOptionalRawJSON(updatedExamplesRaw)
		item.Version = item.Version + 1
		item.UpdatedAt = now
		item.LastModifiedBy = &actorID
		if finalize != nil {
			finalize(&item)
		}

		respBytes, err := json.Marshal(&item)
		if err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("failed to serialize example receipt: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO item_example_operations (
				actor_id, operation_id, item_id, collection_id, op, fingerprint, item_version, response_json
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
		`, actorID, operationID, item.ID, item.CollectionID, op, fingerprint, item.Version, string(respBytes)); err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("failed to record example operation receipt: %w", err)
		}

		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("failed to commit example mutation: %w", err)
		}
		outItem = &item
		return outItem, nil
	}

	return nil, ErrVersionConflict
}

// ListCollectionExamplesPage reads a consistent repeatable-read snapshot page of active request items.
func (r *CollectionRepository) ListCollectionExamplesPage(
	ctx context.Context,
	collectionID uuid.UUID,
	cursor *CollectionExamplesCursor,
	limit int,
) (collectionVersion int64, rowsOut []CollectionExampleRawRow, err error) {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return 0, nil, fmt.Errorf("failed to begin repeatable-read snapshot: %w", err)
	}
	defer tx.Rollback(ctx)

	var deletedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT version, deleted_at FROM collections WHERE id = $1`, collectionID).Scan(&collectionVersion, &deletedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil, ErrCollectionNotFound
		}
		return 0, nil, err
	}
	if deletedAt != nil {
		return 0, nil, ErrCollectionNotFound
	}

	var rows pgx.Rows
	if cursor != nil {
		rows, err = tx.Query(ctx, `
			SELECT id, sort_order, created_at, version, examples
			FROM collection_items
			WHERE collection_id = $1
			  AND type = 'request'
			  AND deleted_at IS NULL
			  AND (sort_order, created_at, id) > ($2, $3, $4)
			ORDER BY sort_order ASC, created_at ASC, id ASC
			LIMIT $5
		`, collectionID, cursor.SortOrder, cursor.CreatedAt, cursor.ID, limit)
	} else {
		rows, err = tx.Query(ctx, `
			SELECT id, sort_order, created_at, version, examples
			FROM collection_items
			WHERE collection_id = $1
			  AND type = 'request'
			  AND deleted_at IS NULL
			ORDER BY sort_order ASC, created_at ASC, id ASC
			LIMIT $2
		`, collectionID, limit)
	}
	if err != nil {
		return 0, nil, fmt.Errorf("failed to list collection examples page: %w", err)
	}
	defer rows.Close()

	rowsOut = make([]CollectionExampleRawRow, 0)
	for rows.Next() {
		var row CollectionExampleRawRow
		if err := rows.Scan(&row.ItemID, &row.SortOrder, &row.CreatedAt, &row.ItemVersion, &row.Examples); err != nil {
			return 0, nil, fmt.Errorf("failed to scan collection example row: %w", err)
		}
		rowsOut = append(rowsOut, row)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, err
	}
	return collectionVersion, rowsOut, nil
}

// ReplaceCollectionAtomic replaces all items in an existing collection inside one ACID transaction with receipt replay.
func (r *CollectionRepository) ReplaceCollectionAtomic(
	ctx context.Context,
	actorID uuid.UUID,
	collectionID uuid.UUID,
	operationID uuid.UUID,
	fingerprint string,
	baseVersion int64,
	name string,
	description *string,
	flatItems []ReplaceFlatItem,
	beforeCommitCheck func(col *domain.Collection) error,
) (*ReplaceCollectionReceipt, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin replace transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var existingFP string
	var existingResp json.RawMessage
	err = tx.QueryRow(ctx, `
		SELECT fingerprint, response_json
		FROM collection_replace_operations
		WHERE actor_id = $1 AND operation_id = $2
		FOR UPDATE
	`, actorID, operationID).Scan(&existingFP, &existingResp)
	if err == nil {
		if existingFP != fingerprint {
			return nil, ErrVersionConflict
		}
		var receipt ReplaceCollectionReceipt
		if err := json.Unmarshal(existingResp, &receipt); err != nil {
			return nil, fmt.Errorf("failed to decode replace receipt: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("failed to check replace receipt: %w", err)
	}

	var col domain.Collection
	err = tx.QueryRow(ctx, `
		SELECT id, workspace_id, project_id, name, description, min_role, version, deleted_at
		FROM collections
		WHERE id = $1
		FOR UPDATE
	`, collectionID).Scan(&col.ID, &col.WorkspaceID, &col.ProjectID, &col.Name, &col.Description, &col.MinRole, &col.Version, &col.DeletedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCollectionNotFound
		}
		return nil, err
	}
	if col.DeletedAt != nil {
		return nil, ErrCollectionNotFound
	}
	if beforeCommitCheck != nil {
		if err := beforeCommitCheck(&col); err != nil {
			return nil, err
		}
	}
	if col.Version != baseVersion {
		return nil, ErrVersionConflict
	}

	incomingSet := make(map[uuid.UUID]struct{}, len(flatItems))
	for _, it := range flatItems {
		incomingSet[it.ID] = struct{}{}
	}

	existingRows, err := tx.Query(ctx, `
		SELECT id
		FROM collection_items
		WHERE collection_id = $1 AND deleted_at IS NULL
		ORDER BY id ASC
		FOR UPDATE
	`, collectionID)
	if err != nil {
		return nil, err
	}
	var toDelete []string
	for existingRows.Next() {
		var eid uuid.UUID
		if err := existingRows.Scan(&eid); err != nil {
			existingRows.Close()
			return nil, err
		}
		if _, keep := incomingSet[eid]; !keep {
			toDelete = append(toDelete, eid.String())
		}
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return nil, err
	}
	existingRows.Close()

	now := time.Now().UTC()
	if len(toDelete) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE collection_items
			SET deleted_at = $1, updated_at = $1, last_modified_by = $2, version = version + 1
			WHERE collection_id = $3 AND id = ANY($4::text[]::uuid[]) AND deleted_at IS NULL
		`, now, actorID, collectionID, toDelete); err != nil {
			return nil, fmt.Errorf("failed to soft-delete replaced items: %w", err)
		}
	}

	const upsertQuery = `
		INSERT INTO collection_items (
			id, collection_id, parent_id, type, name, sort_order,
			method, url, params, path_variables, headers, auth, body_type, raw_type,
			body_content, graphql_query, graphql_variables, body_form_data,
			pre_request_script, post_response_script, examples, version, last_modified_by,
			created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11, $12, $13, $14,
			$15, $16, $17, $18,
			$19, $20, $21::jsonb, 1, $22,
			$23, $23
		)
		ON CONFLICT (id) DO UPDATE SET
			collection_id = EXCLUDED.collection_id,
			parent_id = EXCLUDED.parent_id,
			type = EXCLUDED.type,
			deleted_at = NULL,
			name = EXCLUDED.name,
			sort_order = EXCLUDED.sort_order,
			method = EXCLUDED.method,
			url = EXCLUDED.url,
			params = EXCLUDED.params,
			path_variables = EXCLUDED.path_variables,
			headers = EXCLUDED.headers,
			auth = EXCLUDED.auth,
			body_type = EXCLUDED.body_type,
			raw_type = EXCLUDED.raw_type,
			body_content = EXCLUDED.body_content,
			graphql_query = EXCLUDED.graphql_query,
			graphql_variables = EXCLUDED.graphql_variables,
			body_form_data = EXCLUDED.body_form_data,
			pre_request_script = EXCLUDED.pre_request_script,
			post_response_script = EXCLUDED.post_response_script,
			examples = EXCLUDED.examples,
			version = collection_items.version + 1,
			last_modified_by = EXCLUDED.last_modified_by,
			updated_at = EXCLUDED.updated_at
		WHERE collection_items.collection_id = EXCLUDED.collection_id
	`

	for _, item := range flatItems {
		exArg := "[]"
		if item.Type == domain.ItemTypeRequest && len(item.Examples) > 0 {
			exArg = string(item.Examples)
		}
		res, err := tx.Exec(ctx, upsertQuery,
			item.ID, collectionID, item.ParentID, string(item.Type), item.Name, item.SortOrder,
			item.Method, item.URL, item.Params, item.PathVariables, item.Headers, item.Auth,
			item.BodyType, item.RawType, item.BodyContent, item.GraphQLQuery,
			item.GraphQLVariables, item.BodyFormData, item.PreRequestScript,
			item.PostResponseScript, exArg, actorID, now,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to upsert item during replace: %w", err)
		}
		if res.RowsAffected() != 1 {
			return nil, ErrVersionConflict
		}
	}

	var nextVersion int64
	if err := tx.QueryRow(ctx, `
		UPDATE collections
		SET name = $2, description = $3, version = version + 1, updated_at = $4, last_modified_by = $5
		WHERE id = $1 AND deleted_at IS NULL
		RETURNING version
	`, collectionID, name, description, now, actorID).Scan(&nextVersion); err != nil {
		return nil, fmt.Errorf("failed to update collection metadata: %w", err)
	}

	receipt := &ReplaceCollectionReceipt{
		OperationID:  operationID,
		Status:       "committed",
		CollectionID: collectionID,
		Version:      nextVersion,
		ItemCount:    len(flatItems),
	}
	receiptBytes, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO collection_replace_operations (actor_id, operation_id, collection_id, fingerprint, response_json)
		VALUES ($1, $2, $3, $4, $5::jsonb)
	`, actorID, operationID, collectionID, fingerprint, string(receiptBytes)); err != nil {
		return nil, fmt.Errorf("failed to store replace receipt: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("failed to commit replace transaction: %w", err)
	}
	return receipt, nil
}
