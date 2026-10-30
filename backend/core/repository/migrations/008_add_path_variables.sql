-- 008_add_path_variables.sql: Add path_variables JSONB column to collection_items
ALTER TABLE collection_items
ADD COLUMN IF NOT EXISTS path_variables JSONB DEFAULT '[]'::jsonb;

