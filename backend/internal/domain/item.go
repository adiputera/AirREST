package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type ItemType string

const (
	ItemTypeFolder  ItemType = "folder"
	ItemTypeRequest ItemType = "request"
)

type CollectionItem struct {
	ID                 uuid.UUID        `json:"id"`
	CollectionID       uuid.UUID        `json:"collection_id"`
	ParentID           *uuid.UUID       `json:"parent_id,omitempty"`
	Type               ItemType         `json:"type"`
	Name               string           `json:"name"`
	SortOrder          int              `json:"sort_order"`
	Method             *string          `json:"method,omitempty"`
	URL                *string          `json:"url,omitempty"`
	Params             *json.RawMessage `json:"params,omitempty"`
	Headers            *json.RawMessage `json:"headers,omitempty"`
	Auth               *json.RawMessage `json:"auth,omitempty"`
	BodyType           *string          `json:"body_type,omitempty"`
	RawType            *string          `json:"raw_type,omitempty"`
	BodyContent        *string          `json:"body_content,omitempty"`
	GraphQLQuery       *string          `json:"graphql_query,omitempty"`
	GraphQLVariables   *string          `json:"graphql_variables,omitempty"`
	BodyFormData       *json.RawMessage `json:"body_form_data,omitempty"`
	PreRequestScript   *string          `json:"pre_request_script,omitempty"`
	PostResponseScript *string          `json:"post_response_script,omitempty"`
	Version            int64            `json:"version"`
	LastModifiedBy     *uuid.UUID       `json:"last_modified_by,omitempty"`
	CreatedAt          time.Time        `json:"created_at"`
	UpdatedAt          time.Time        `json:"updated_at"`
	DeletedAt          *time.Time       `json:"deleted_at,omitempty"`

	// Populated for nested folder tree
	Items []*CollectionItem `json:"items,omitempty"`
}

// ReorderItemPosition represents a target position and parent folder for an item
type ReorderItemPosition struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	SortOrder int        `json:"sort_order"`
}

