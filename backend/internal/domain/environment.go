package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type Environment struct {
	ID             uuid.UUID        `json:"id"`
	WorkspaceID    *uuid.UUID       `json:"workspace_id,omitempty"`
	ProjectID      *uuid.UUID       `json:"project_id,omitempty"`
	Name           string           `json:"name"`
	Variables      *json.RawMessage `json:"variables"`
	Version        int64            `json:"version"`
	LastModifiedBy *uuid.UUID       `json:"last_modified_by,omitempty"`
	CreatedAt      time.Time        `json:"created_at"`
	UpdatedAt      time.Time        `json:"updated_at"`
	DeletedAt      *time.Time       `json:"deleted_at,omitempty"`
}
