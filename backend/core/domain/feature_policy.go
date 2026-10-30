package domain

import (
	"time"

	"github.com/google/uuid"
)

const (
	FeatureCollectionMove   = "collection.move"
	FeatureCollectionDelete = "collection.delete"
	FeatureCollectionExport = "collection.export"
)

type FeatureFlags struct {
	CollectionMove   bool `json:"collection.move"`
	CollectionDelete bool `json:"collection.delete"`
	CollectionExport bool `json:"collection.export"`
}

type FeaturePolicy struct {
	Flags     FeatureFlags `json:"flags"`
	Revision  int64        `json:"revision"`
	UpdatedBy *uuid.UUID   `json:"updated_by,omitempty"`
	UpdatedAt time.Time    `json:"updated_at"`
}

func DefaultFeatureFlags() FeatureFlags {
	return FeatureFlags{
		CollectionMove:   true,
		CollectionDelete: true,
		CollectionExport: true,
	}
}

func (f FeatureFlags) IsEnabled(feature string) bool {
	switch feature {
	case FeatureCollectionMove:
		return f.CollectionMove
	case FeatureCollectionDelete:
		return f.CollectionDelete
	case FeatureCollectionExport:
		return f.CollectionExport
	default:
		return false
	}
}
