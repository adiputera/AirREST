package service

import (
	"context"
	"errors"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// authorizeImportScope uses only the transaction's connection. Share locks keep
// ownership and effective membership stable until all imported writes commit.
func authorizeImportScope(ctx context.Context, tx pgx.Tx, user *domain.User, workspaceID, projectID *uuid.UUID) (domain.ProjectRole, error) {
	if workspaceID != nil {
		var owner uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT owner_id FROM workspaces WHERE id=$1 FOR SHARE`, *workspaceID).Scan(&owner); err != nil {
			return "", err
		}
		if !user.IsSuperadmin() && owner != user.ID {
			return "", ErrForbidden
		}
		return domain.ProjectRoleAdmin, nil
	}
	var teamID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT team_id FROM projects WHERE id=$1 FOR SHARE`, *projectID).Scan(&teamID); err != nil {
		return "", err
	}
	if user.IsSuperadmin() {
		return domain.ProjectRoleAdmin, nil
	}
	var teamRole string
	if err := tx.QueryRow(ctx, `SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, teamID, user.ID).Scan(&teamRole); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrForbidden
		}
		return "", err
	}
	if teamRole == "admin" {
		return domain.ProjectRoleAdmin, nil
	}
	var role domain.ProjectRole
	if err := tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE`, *projectID, user.ID).Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrForbidden
		}
		return "", err
	}
	if !domain.HasPermission(domain.GetPermissionsForRole(role), domain.PermissionCollectionWrite) {
		return "", ErrForbidden
	}
	return role, nil
}
