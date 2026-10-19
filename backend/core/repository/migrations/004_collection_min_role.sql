-- Add min_role column to collections table for granular project RBAC
ALTER TABLE collections 
ADD COLUMN IF NOT EXISTS min_role VARCHAR(20) NOT NULL DEFAULT 'reader' 
CHECK (min_role IN ('admin', 'maintainer', 'contributor', 'reader'));
