-- Add min_role column to environments table for granular project RBAC
ALTER TABLE environments 
ADD COLUMN IF NOT EXISTS min_role VARCHAR(20) NOT NULL DEFAULT 'reader' 
CHECK (min_role IN ('admin', 'maintainer', 'contributor', 'reader'));
