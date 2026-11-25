-- 010_saved_examples.sql: Persist Postman-compatible Saved Examples and durable operation receipts

ALTER TABLE collection_items
ADD COLUMN IF NOT EXISTS examples JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.conname = 'chk_collection_items_examples_array'
          AND t.relname = 'collection_items'
          AND pg_table_is_visible(t.oid)
    ) THEN
        ALTER TABLE collection_items
        ADD CONSTRAINT chk_collection_items_examples_array CHECK (jsonb_typeof(examples) = 'array');
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.conname = 'chk_collection_items_folder_empty_examples'
          AND t.relname = 'collection_items'
          AND pg_table_is_visible(t.oid)
    ) THEN
        ALTER TABLE collection_items
        ADD CONSTRAINT chk_collection_items_folder_empty_examples CHECK (type <> 'folder' OR examples = '[]'::jsonb);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS item_example_operations (
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    item_id UUID NOT NULL,
    collection_id UUID NOT NULL,
    op VARCHAR(16) NOT NULL CHECK (op IN ('add', 'rename', 'delete')),
    fingerprint VARCHAR(64) NOT NULL,
    item_version BIGINT NOT NULL,
    response_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_item_example_operations_created_at
    ON item_example_operations(created_at);

CREATE TABLE IF NOT EXISTS collection_replace_operations (
    actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    collection_id UUID NOT NULL,
    fingerprint VARCHAR(64) NOT NULL,
    response_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (actor_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_collection_replace_operations_created_at
    ON collection_replace_operations(created_at);
