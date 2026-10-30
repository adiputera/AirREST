-- Standardize default private workspace names to 'Default Workspace'
UPDATE workspaces
SET name = 'Default Workspace'
WHERE is_default = TRUE AND name IN ('Superadmin Workspace', 'My Workspace', 'Personal Workspace');

