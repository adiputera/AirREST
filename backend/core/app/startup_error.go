package app

import "errors"

// StartupStage identifies which initialization step failed.
type StartupStage string

const (
	// StageConfig covers environment/configuration validation.
	StageConfig StartupStage = "CONFIG_INVALID"
	// StageDatabase covers parsing, opening, and pinging the database.
	StageDatabase StartupStage = "DATABASE_UNAVAILABLE"
	// StageMigration covers boot schema migrations.
	StageMigration StartupStage = "MIGRATION_FAILED"
	// StageBootstrap covers initial superadmin bootstrap.
	StageBootstrap StartupStage = "BOOTSTRAP_FAILED"
)

// StartupError wraps an initialization failure with the stage where it happened.
// The stage is safe to expose to clients; the wrapped error is for server logs only.
type StartupError struct {
	Stage StartupStage
	Err   error
}

// Error returns the underlying error message.
func (e *StartupError) Error() string { return e.Err.Error() }

// Unwrap returns the underlying error.
func (e *StartupError) Unwrap() error { return e.Err }

// StageOf returns the startup stage carried by err, or an empty stage when unknown.
func StageOf(err error) StartupStage {
	var se *StartupError
	if errors.As(err, &se) {
		return se.Stage
	}
	return ""
}
