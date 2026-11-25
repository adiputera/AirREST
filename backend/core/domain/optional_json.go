package domain

import (
	"bytes"
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// OptionalRawJSON tracks JSON field presence explicitly so callers can distinguish
// absent fields, explicit JSON null, and concrete JSON payloads without pointer ambiguity.
type OptionalRawJSON struct {
	Present bool
	IsNull  bool
	Raw     json.RawMessage
}

// NewOptionalRawJSON constructs a present non-null OptionalRawJSON value from raw bytes.
func NewOptionalRawJSON(raw []byte) OptionalRawJSON {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return OptionalRawJSON{
			Present: true,
			Raw:     json.RawMessage("[]"),
		}
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return OptionalRawJSON{
			Present: true,
			IsNull:  true,
			Raw:     json.RawMessage("null"),
		}
	}
	copied := make([]byte, len(trimmed))
	copy(copied, trimmed)
	return OptionalRawJSON{
		Present: true,
		Raw:     json.RawMessage(copied),
	}
}

// UnmarshalJSON decodes a JSON field while recording presence and explicit null.
func (o *OptionalRawJSON) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	o.Present = true
	if bytes.Equal(trimmed, []byte("null")) {
		o.IsNull = true
		o.Raw = json.RawMessage("null")
		return nil
	}
	o.IsNull = false
	copied := make([]byte, len(data))
	copy(copied, data)
	o.Raw = json.RawMessage(copied)
	return nil
}

// MarshalJSON encodes the raw JSON bytes when present.
func (o OptionalRawJSON) MarshalJSON() ([]byte, error) {
	if !o.Present {
		return []byte("null"), nil
	}
	if o.IsNull || len(o.Raw) == 0 {
		return []byte("null"), nil
	}
	return o.Raw, nil
}

// IsZero lets encoding/json omit unset OptionalRawJSON fields with omitzero.
func (o OptionalRawJSON) IsZero() bool {
	return !o.Present
}

// Scan implements sql.Scanner for PostgreSQL JSONB columns.
func (o *OptionalRawJSON) Scan(src any) error {
	if src == nil {
		*o = OptionalRawJSON{}
		return nil
	}
	switch v := src.(type) {
	case []byte:
		*o = NewOptionalRawJSON(v)
		return nil
	case string:
		*o = NewOptionalRawJSON([]byte(v))
		return nil
	default:
		return fmt.Errorf("cannot scan %T into OptionalRawJSON", src)
	}
}

// Value implements driver.Valuer for PostgreSQL JSONB columns.
func (o OptionalRawJSON) Value() (driver.Value, error) {
	if !o.Present || o.IsNull || len(o.Raw) == 0 {
		return "[]", nil
	}
	return string(o.Raw), nil
}
