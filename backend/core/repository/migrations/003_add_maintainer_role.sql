-- Add 'maintainer' role to project_members and environments
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check 
CHECK (role IN ('admin', 'maintainer', 'contributor', 'reader'));

ALTER TABLE environments DROP CONSTRAINT IF EXISTS environments_min_role_check;
ALTER TABLE environments ADD CONSTRAINT environments_min_role_check 
CHECK (min_role IN ('admin', 'maintainer', 'contributor', 'reader'));
