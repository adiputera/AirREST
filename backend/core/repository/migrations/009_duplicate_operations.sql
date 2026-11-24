-- 009_duplicate_operations.sql: Durable idempotency ledger for atomic duplicate operations
CREATE TABLE IF NOT EXISTS duplicate_operations (
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('collection', 'import_duplicate', 'item')),
    fingerprint VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'expired')),
    created_resource_id UUID,
    target_collection_id UUID,
    target_workspace_id UUID,
    target_project_id UUID,
    target_parent_id UUID,
    result_name VARCHAR(150),
    result_min_role VARCHAR(20),
    result_version BIGINT,
    item_count INT NOT NULL DEFAULT 0,
    committed_at TIMESTAMPTZ,
    receipt_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_operations_expires ON duplicate_operations(receipt_expires_at);
