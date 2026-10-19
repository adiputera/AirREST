package domain

import (
	"time"

	"github.com/google/uuid"
)

type Collection struct {
	ID             uuid.UUID  `json:"id"`
	WorkspaceID    *uuid.UUID `json:"workspace_id,omitempty"`
	ProjectID      *uuid.UUID `json:"project_id,omitempty"`
	Name           string     `json:"name"`
	Description    *string     `json:"description,omitempty"`
	MinRole        ProjectRole `json:"min_role"`
	Version        int64       `json:"version"`
	CreatedBy      uuid.UUID  `json:"created_by"`
	LastModifiedBy *uuid.UUID `json:"last_modified_by,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	DeletedAt      *time.Time `json:"deleted_at,omitempty"`

	// Populated for nested trees
	Items []*CollectionItem `json:"items,omitempty"`
}
