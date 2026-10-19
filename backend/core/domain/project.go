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

type Project struct {
	ID          uuid.UUID `json:"id"`
	TeamID      uuid.UUID `json:"team_id"`
	Name        string    `json:"name"`
	Description *string   `json:"description,omitempty"`
	CreatedBy   uuid.UUID `json:"created_by"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
	UserRole    *ProjectRole `json:"user_role,omitempty"`
}

type ProjectMember struct {
	ID        uuid.UUID   `json:"id"`
	ProjectID uuid.UUID   `json:"project_id"`
	UserID    uuid.UUID   `json:"user_id"`
	Role      ProjectRole `json:"role"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`

	// Populated in queries
	User *User `json:"user,omitempty"`
}
