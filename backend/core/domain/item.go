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

type SavedExampleHeader struct {
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Disabled    bool    `json:"disabled,omitempty"`
	Description *string `json:"description,omitempty"`
}

type SavedExample struct {
	ID              string               `json:"id"`
	Revision        int64                `json:"revision"`
	Name            string               `json:"name"`
	OriginalRequest *json.RawMessage     `json:"originalRequest,omitempty"`
	Status          string               `json:"status"`
	Code            int                  `json:"code"`
	Header          []SavedExampleHeader `json:"header"`
	Cookie          []any                `json:"cookie,omitempty"`
	Body            string               `json:"body"`
	PreviewLanguage *string              `json:"_postman_previewlanguage,omitempty"`
}

type SavedExampleSummary struct {
	ID              string  `json:"id"`
	Revision        int64   `json:"revision"`
	Name            string  `json:"name"`
	Code            int     `json:"code"`
	Status          string  `json:"status"`
	PreviewLanguage *string `json:"_postman_previewlanguage,omitempty"`
	BodySizeBytes   int     `json:"body_size_bytes"`
}

type CollectionItem struct {
	ID                        uuid.UUID             `json:"id"`
	CollectionID              uuid.UUID             `json:"collection_id"`
	ParentID                  *uuid.UUID            `json:"parent_id,omitempty"`
	Type                      ItemType              `json:"type"`
	Name                      string                `json:"name"`
	SortOrder                 int                   `json:"sort_order"`
	Method                    *string               `json:"method,omitempty"`
	URL                       *string               `json:"url,omitempty"`
	Params                    *json.RawMessage      `json:"params,omitempty"`
	PathVariables             *json.RawMessage      `json:"path_variables,omitempty"`
	Headers                   *json.RawMessage      `json:"headers,omitempty"`
	Auth                      *json.RawMessage      `json:"auth,omitempty"`
	BodyType                  *string               `json:"body_type,omitempty"`
	RawType                   *string               `json:"raw_type,omitempty"`
	BodyContent               *string               `json:"body_content,omitempty"`
	GraphQLQuery              *string               `json:"graphql_query,omitempty"`
	GraphQLVariables          *string               `json:"graphql_variables,omitempty"`
	BodyFormData              *json.RawMessage      `json:"body_form_data,omitempty"`
	PreRequestScript          *string               `json:"pre_request_script,omitempty"`
	PostResponseScript        *string               `json:"post_response_script,omitempty"`
	Examples                  OptionalRawJSON       `json:"examples,omitzero"`
	ExampleSummaries          []SavedExampleSummary `json:"example_summaries,omitempty"`
	ExampleCount              *int                  `json:"example_count,omitempty"`
	ExampleSummariesTruncated *bool                 `json:"example_summaries_truncated,omitempty"`
	ExamplesLoaded            *bool                 `json:"examples_loaded,omitempty"`
	Version                   int64                 `json:"version"`
	LastModifiedBy            *uuid.UUID            `json:"last_modified_by,omitempty"`
	CreatedAt                 time.Time             `json:"created_at"`
	UpdatedAt                 time.Time             `json:"updated_at"`
	DeletedAt                 *time.Time            `json:"deleted_at,omitempty"`

	// Populated for nested folder tree
	Items []*CollectionItem `json:"items,omitempty"`
}

// ReorderItemPosition represents a target position and parent folder for an item
type ReorderItemPosition struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id"`
	SortOrder int        `json:"sort_order"`
}

