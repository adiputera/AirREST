ALTER TABLE feature_policies
    DROP CONSTRAINT IF EXISTS feature_policies_updated_by_fkey,
    ADD CONSTRAINT feature_policies_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
