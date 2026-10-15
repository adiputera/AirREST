package handler

import (
	"encoding/json"
	"net/http"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type ProjectHandler struct {
	projectService *service.ProjectService
}

func NewProjectHandler(projectService *service.ProjectService) *ProjectHandler {
	return &ProjectHandler{projectService: projectService}
}

type ProjectRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ProjectMemberRequest struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"` // 'admin', 'contributor', 'reader'
}

func (h *ProjectHandler) ListByTeam(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	teamIDStr := chi.URLParam(r, "teamId")
	teamID, err := uuid.Parse(teamIDStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	projects, err := h.projectService.ListProjects(r.Context(), user, teamID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to list projects", "SERVER_ERROR")
		return
	}
	response.JSON(w, http.StatusOK, projects)
}

func (h *ProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	teamIDStr := chi.URLParam(r, "teamId")
	teamID, err := uuid.Parse(teamIDStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid team id", "BAD_REQUEST")
		return
	}

	var req ProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	project, err := h.projectService.CreateProject(r.Context(), user, teamID, req.Name, req.Description)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusCreated, project)
}

func (h *ProjectHandler) Get(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	project, err := h.projectService.GetProject(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusNotFound, "project not found or access forbidden", "NOT_FOUND")
		return
	}
	response.JSON(w, http.StatusOK, project)
}

func (h *ProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	var req ProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	project, err := h.projectService.UpdateProject(r.Context(), user, id, req.Name, req.Description)
	if err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, project)
}

func (h *ProjectHandler) Delete(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	if err := h.projectService.DeleteProject(r.Context(), user, id); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "project deleted successfully"})
}

func (h *ProjectHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	members, err := h.projectService.ListProjectMembers(r.Context(), user, id)
	if err != nil {
		response.Error(w, http.StatusForbidden, "access forbidden", "FORBIDDEN")
		return
	}
	response.JSON(w, http.StatusOK, members)
}

func (h *ProjectHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	projectID, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	var req ProjectMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body", "BAD_REQUEST")
		return
	}

	targetUserID, err := uuid.Parse(req.UserID)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	role := domain.ProjectRoleReader
	switch req.Role {
	case string(domain.ProjectRoleAdmin):
		role = domain.ProjectRoleAdmin
	case string(domain.ProjectRoleContributor):
		role = domain.ProjectRoleContributor
	}

	if err := h.projectService.AddProjectMember(r.Context(), user, projectID, targetUserID, role); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "project member assigned successfully"})
}

func (h *ProjectHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUserFromContext(r.Context())
	idStr := chi.URLParam(r, "id")
	projectID, err := uuid.Parse(idStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid project id", "BAD_REQUEST")
		return
	}

	userIDStr := chi.URLParam(r, "userId")
	targetUserID, err := uuid.Parse(userIDStr)
	if err != nil {
		response.Error(w, http.StatusBadRequest, "invalid user id", "BAD_REQUEST")
		return
	}

	if err := h.projectService.RemoveProjectMember(r.Context(), user, projectID, targetUserID); err != nil {
		response.Error(w, http.StatusForbidden, err.Error(), "OPERATION_FAILED")
		return
	}
	response.JSON(w, http.StatusOK, map[string]string{"message": "project member unassigned successfully"})
}
