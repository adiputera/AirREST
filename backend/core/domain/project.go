package domain

import (
	"time"

	"github.com/google/uuid"
)

type ProjectRole string

const (
	ProjectRoleAdmin       ProjectRole = "admin"
	ProjectRoleMaintainer  ProjectRole = "maintainer"
	ProjectRoleContributor ProjectRole = "contributor"
	ProjectRoleReader      ProjectRole = "reader"
)

const (
	PermissionWildcard         = "*"
	PermissionCollectionRead   = "collection:read"
	PermissionCollectionWrite  = "collection:write"
	PermissionCollectionDelete = "collection:delete"
	PermissionCollectionMove   = "collection:move"
	PermissionEnvRead          = "env:read"
	PermissionEnvWrite         = "env:write"
	PermissionEnvDelete        = "env:delete"
)

var RolePermissions = map[ProjectRole][]string{
	ProjectRoleAdmin: {
		PermissionWildcard,
	},
	ProjectRoleMaintainer: {
		PermissionCollectionRead,
		PermissionCollectionWrite,
		PermissionCollectionDelete,
		PermissionCollectionMove,
		PermissionEnvRead,
		PermissionEnvWrite,
		PermissionEnvDelete,
	},
	ProjectRoleContributor: {
		PermissionCollectionRead,
		PermissionCollectionWrite,
		PermissionEnvRead,
		PermissionEnvWrite,
	},
	ProjectRoleReader: {
		PermissionCollectionRead,
		PermissionEnvRead,
	},
}

func GetPermissionsForRole(role ProjectRole) []string {
	if perms, ok := RolePermissions[role]; ok {
		res := make([]string, len(perms))
		copy(res, perms)
		return res
	}
	return []string{}
}

func HasPermission(perms []string, targetPerm string) bool {
	for _, p := range perms {
		if p == PermissionWildcard || p == targetPerm {
			return true
		}
	}
	return false
}

type Project struct {
	ID          uuid.UUID    `json:"id"`
	TeamID      uuid.UUID    `json:"team_id"`
	Name        string       `json:"name"`
	Description *string      `json:"description,omitempty"`
	CreatedBy   uuid.UUID    `json:"created_by"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
	UserRole    *ProjectRole `json:"user_role,omitempty"`
	Permissions []string     `json:"permissions,omitempty"`
}

type ProjectMember struct {
	ID          uuid.UUID    `json:"id"`
	ProjectID   uuid.UUID    `json:"project_id"`
	UserID      uuid.UUID    `json:"user_id"`
	Role        ProjectRole  `json:"role"`
	Permissions []string     `json:"permissions,omitempty"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`

	// Populated in queries
	User *User `json:"user,omitempty"`
}
