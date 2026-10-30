CREATE TABLE IF NOT EXISTS feature_policies (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    collection_move_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    collection_delete_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    collection_export_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feature_policies (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS feature_policy_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    revision BIGINT NOT NULL,
    collection_move_enabled BOOLEAN NOT NULL,
    collection_delete_enabled BOOLEAN NOT NULL,
    collection_export_enabled BOOLEAN NOT NULL,
    updated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_policy_audit_revision ON feature_policy_audit(revision);
