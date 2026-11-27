package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/google/uuid"
)

func parseOptionalQueryUUID(w http.ResponseWriter, raw string, invalidMessage string) (*uuid.UUID, bool) {
	if raw == "" {
		return nil, true
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		response.Error(w, http.StatusBadRequest, invalidMessage, "BAD_REQUEST")
		return nil, false
	}
	return &id, true
}

func isValidationServiceError(err error) bool {
	return errors.Is(err, service.ErrInvalidItemPayload) ||
		errors.Is(err, service.ErrInvalidScope) ||
		errors.Is(err, service.ErrInvalidCollectionMove) ||
		errors.Is(err, service.ErrInvalidEmail) ||
		errors.Is(err, service.ErrPasswordTooShort) ||
		errors.Is(err, service.ErrPasswordTooLong) ||
		errors.Is(err, service.ErrNameRequired) ||
		errors.Is(err, service.ErrNameTooLong) ||
		errors.Is(err, service.ErrCannotDeleteDefaultWorkspace) ||
		errors.Is(err, postgres.ErrInvalidReorder)
}

func isForbiddenServiceError(err error) bool {
	return errors.Is(err, service.ErrForbidden) ||
		errors.Is(err, service.ErrReaderCannotModify) ||
		errors.Is(err, service.ErrEnvAccessDenied) ||
		errors.Is(err, service.ErrAdminRequiredForEnv) ||
		errors.Is(err, service.ErrSuperadminRequired) ||
		errors.Is(err, service.ErrTeamAdminRequired) ||
		errors.Is(err, service.ErrProjectCollectionMoveToPersonalScope)
}

func isNotFoundServiceError(err error) bool {
	return errors.Is(err, postgres.ErrCollectionNotFound) ||
		errors.Is(err, postgres.ErrItemNotFound) ||
		errors.Is(err, postgres.ErrEnvironmentNotFound) ||
		errors.Is(err, postgres.ErrProjectNotFound) ||
		errors.Is(err, postgres.ErrProjectMemberNotFound) ||
		errors.Is(err, postgres.ErrTeamNotFound) ||
		errors.Is(err, postgres.ErrTeamMemberNotFound) ||
		errors.Is(err, postgres.ErrWorkspaceNotFound) ||
		errors.Is(err, postgres.ErrUserNotFound) ||
		errors.Is(err, service.ErrExampleNotFound)
}

func writeMappedError(w http.ResponseWriter, operation string, err error, conflictData any) {
	switch {
	case errors.Is(err, service.ErrFeatureDisabled):
		response.Error(w, http.StatusForbidden, err.Error(), "FEATURE_DISABLED")
	case errors.Is(err, service.ErrFeaturePolicyUnavailable):
		response.Error(w, http.StatusServiceUnavailable, "feature policy unavailable", "FEATURE_POLICY_UNAVAILABLE")
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		response.Error(w, http.StatusServiceUnavailable, "request timed out", "REQUEST_TIMEOUT")
	case errors.Is(err, postgres.ErrVersionConflict), errors.Is(err, service.ErrExampleConflict):
		response.Conflict(w, err.Error(), conflictData)
	case errors.Is(err, service.ErrExampleLimitExceeded), errors.Is(err, service.ErrBatchLimit), errors.Is(err, postgres.ErrCollectionItemLimit):
		response.Error(w, http.StatusRequestEntityTooLarge, err.Error(), "LIMIT_EXCEEDED")
	case isValidationServiceError(err):
		response.Error(w, http.StatusBadRequest, err.Error(), "BAD_REQUEST")
	case isNotFoundServiceError(err):
		response.Error(w, http.StatusNotFound, "resource not found", "NOT_FOUND")
	case isForbiddenServiceError(err):
		response.Error(w, http.StatusForbidden, err.Error(), "FORBIDDEN")
	default:
		slog.Error("handler operation failed", "operation", operation, "error", err)
		response.Error(w, http.StatusInternalServerError, "internal server error", "SERVER_ERROR")
	}
}
