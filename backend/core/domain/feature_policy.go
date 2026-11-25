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

type FeaturePolicyCapabilities struct {
	SavedExamples bool `json:"saved_examples"`
}

type FeaturePolicy struct {
	Flags        FeatureFlags               `json:"flags"`
	Revision     int64                      `json:"revision"`
	UpdatedBy    *uuid.UUID                 `json:"updated_by,omitempty"`
	UpdatedAt    time.Time                  `json:"updated_at"`
	Capabilities *FeaturePolicyCapabilities `json:"capabilities,omitempty"`
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
