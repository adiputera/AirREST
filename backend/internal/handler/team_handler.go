package handler

import (
	"encoding/json"
	"net/http"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/adiputera/airrest-backend/internal/middleware"
	"github.com/adiputera/airrest-backend/internal/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type TeamHandler struct {
	teamService *service.TeamService
}

func NewTeamHandler(teamService *service.TeamService) *TeamHandler {
	return &TeamHandler{teamService: teamService}
}

type TeamRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type TeamMemberRequest struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"` // 'admin' or 'member'
}

func (h *TeamHandler) List(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	teams, err := h.teamService.ListTeams(r.Context(), user)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list teams", "SERVER_ERROR")
		return
	}
	response.JSON(w, http.StatusOK, teams)
}

func (h *TeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	var req TeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	team, err := h.teamService.CreateTeam(r.Context(), user, req.Name, req.Description)
	if err != nil {
		if err == service.ErrSuperadminRequired {
			response.Error(w, http.StatusForbidden, err.Error(), "FORBIDDEN")
			return
		}
		response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}
	response.JSON(w, http.StatusCreated, team)
}

func (h *TeamHandler) Get(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	team, err := h.teamService.GetTeam(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "team not found or access forbidden", "NOT_FOUND")
		return
	}
	response.JSON(w, http.StatusOK, team)
}

func (h *TeamHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	var req TeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	team, err := h.teamService.UpdateTeam(r.Context(), user, id, req.Name, req.Description)
	if err != nil {
		if err == service.ErrSuperadminRequired {
			response.Error(w, http.StatusForbidden, err.Error(), "FORBIDDEN")
			return
		}
		response.Error(w, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}
	response.JSON(w, http.StatusOK, team)
}

func (h *TeamHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	if err := h.teamService.DeleteTeam(r.Context(), user, id); err != nil {
		if err == service.ErrSuperadminRequired {
			response.Error(w, http.StatusForbidden, err.Error(), "FORBIDDEN")
			return
		}
		response.Error(w, http.StatusBadRequest, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "team deleted successfully"})
}

func (h *TeamHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	members, err := h.teamService.ListMembers(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusForbidden, "access forbidden", "FORBIDDEN")
		return
	}
	response.JSON(w, http.StatusOK, members)
}

func (h *TeamHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	teamID, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	var req TeamMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	targetUserID, err := uuid.Parse(req.UserID)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	role := domain.TeamRoleMember
	if req.Role == string(domain.TeamRoleAdmin) {
		role = domain.TeamRoleAdmin
	}

	if err := h.teamService.AddMember(r.Context(), user, teamID, targetUserID, role); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "team member added/updated successfully"})
}

func (h *TeamHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	teamID, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	userIDStr := chi.URLParam(r, "userId")
	targetUserID, err := uuid.Parse(userIDStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	if err := h.teamService.RemoveMember(r.Context(), user, teamID, targetUserID); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "team member removed successfully"})
}
