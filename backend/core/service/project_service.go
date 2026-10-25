package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/google/uuid"
)

type ProjectService struct {
	projectRepo *postgres.ProjectRepository
	teamRepo    *postgres.TeamRepository
	teamService *TeamService
}

func NewProjectService(
	projectRepo *postgres.ProjectRepository,
	teamRepo *postgres.TeamRepository,
	teamService *TeamService,
) *ProjectService {
	return &ProjectService{
		projectRepo: projectRepo,
		teamRepo:    teamRepo,
		teamService: teamService,
	}
}

// CreateProject creates a project in a team (allowed by Superadmin or Team Admin)
func (s *ProjectService) CreateProject(ctx context.Context, user *domain.User, teamID uuid.UUID, name, description string) (*domain.Project, error) {
	isTeamAdmin, err := s.teamService.CheckIfTeamAdmin(ctx, user, teamID)
	if err != nil || !isTeamAdmin {
		return nil, ErrTeamAdminRequired
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("project name is required")
	}

	var desc *string
	if description != "" {
		desc = &description
	}

	project := &domain.Project{
		ID:          uuid.New(),
		TeamID:      teamID,
		Name:        name,
		Description: desc,
		CreatedBy:   user.ID,
	}

	if err := s.projectRepo.Create(ctx, project); err != nil {
		return nil, err
	}

	// Add creator as Project Admin
	role := domain.ProjectRoleAdmin
	project.UserRole = &role
	project.Permissions = domain.GetPermissionsForRole(role)

	_ = s.projectRepo.AddMember(ctx, &domain.ProjectMember{
		ID:          uuid.New(),
		ProjectID:   project.ID,
		UserID:      user.ID,
		Role:        domain.ProjectRoleAdmin,
		Permissions: domain.GetPermissionsForRole(domain.ProjectRoleAdmin),
	})

	return project, nil
}

// ListProjects lists projects visible to the user in a team.
// If the user is Superadmin or Team Admin: returns all projects in the team.
// If regular member: returns ONLY projects explicitly assigned in project_members.
func (s *ProjectService) ListProjects(ctx context.Context, user *domain.User, teamID uuid.UUID) ([]*domain.Project, error) {
	if !user.IsSuperadmin() {
		if _, err := s.teamRepo.GetMember(ctx, teamID, user.ID); err != nil {
			return nil, ErrForbidden
		}
	}
	isTeamAdmin, _ := s.teamService.CheckIfTeamAdmin(ctx, user, teamID)
	return s.projectRepo.ListForUser(ctx, teamID, user.ID, user.IsSuperadmin(), isTeamAdmin)
}

// GetProject returns project details if the user has visibility
func (s *ProjectService) GetProject(ctx context.Context, user *domain.User, projectID uuid.UUID) (*domain.Project, error) {
	project, role, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return nil, err
	}
	project.UserRole = &role
	project.Permissions = domain.GetPermissionsForRole(role)
	return project, nil
}

// UpdateProject updates project (allowed by Superadmin, Team Admin, or Project Admin)
func (s *ProjectService) UpdateProject(ctx context.Context, user *domain.User, projectID uuid.UUID, name, description string) (*domain.Project, error) {
	project, role, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return nil, err
	}

	if role != domain.ProjectRoleAdmin {
		return nil, errors.New("admin access required to update project")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("project name is required")
	}
	project.Name = name

	descTrimmed := strings.TrimSpace(description)
	if descTrimmed != "" {
		project.Description = &descTrimmed
	} else {
		project.Description = nil
	}

	if err := s.projectRepo.Update(ctx, project); err != nil {
		return nil, err
	}
	project.UserRole = &role
	project.Permissions = domain.GetPermissionsForRole(role)
	return project, nil
}

// DeleteProject deletes project (allowed by Superadmin, Team Admin, or Project Admin)
func (s *ProjectService) DeleteProject(ctx context.Context, user *domain.User, projectID uuid.UUID) error {
	_, role, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return err
	}

	if role != domain.ProjectRoleAdmin {
		return errors.New("admin access required to delete project")
	}

	return s.projectRepo.Delete(ctx, projectID)
}

// AddProjectMember assigns a user to a project with a role (executed by Team Admin or Project Admin)
func (s *ProjectService) AddProjectMember(ctx context.Context, user *domain.User, projectID, targetUserID uuid.UUID, role domain.ProjectRole) error {
	project, effectiveRole, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return err
	}

	if effectiveRole != domain.ProjectRoleAdmin {
		return errors.New("admin access required to assign project members")
	}

	// Ensure target user is already a member of the team
	_, err = s.teamRepo.GetMember(ctx, project.TeamID, targetUserID)
	if err != nil && !user.IsSuperadmin() {
		return fmt.Errorf("user must be a member of the team before assignment to project: %w", err)
	}

	return s.projectRepo.AddMember(ctx, &domain.ProjectMember{
		ProjectID: projectID,
		UserID:    targetUserID,
		Role:      role,
	})
}

// RemoveProjectMember unassigns a user from a project (making it invisible to them)
func (s *ProjectService) RemoveProjectMember(ctx context.Context, user *domain.User, projectID, targetUserID uuid.UUID) error {
	_, effectiveRole, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return err
	}

	if effectiveRole != domain.ProjectRoleAdmin {
		return errors.New("admin access required to remove project members")
	}

	return s.projectRepo.RemoveMember(ctx, projectID, targetUserID)
}

// ListProjectMembers lists members assigned to project
func (s *ProjectService) ListProjectMembers(ctx context.Context, user *domain.User, projectID uuid.UUID) ([]*domain.ProjectMember, error) {
	_, _, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	if err != nil {
		return nil, err
	}
	members, err := s.projectRepo.ListMembers(ctx, projectID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		m.Permissions = domain.GetPermissionsForRole(m.Role)
	}
	return members, nil
}

// GetEffectiveRole returns the user's role on the project (admin, contributor, reader)
func (s *ProjectService) GetEffectiveRole(ctx context.Context, user *domain.User, projectID uuid.UUID) (domain.ProjectRole, error) {
	_, role, err := s.getProjectAndEffectiveRole(ctx, user, projectID)
	return role, err
}

func (s *ProjectService) getProjectAndEffectiveRole(ctx context.Context, user *domain.User, projectID uuid.UUID) (*domain.Project, domain.ProjectRole, error) {
	project, err := s.projectRepo.GetByID(ctx, projectID)
	if err != nil {
		return nil, "", err
	}

	if user.IsSuperadmin() {
		return project, domain.ProjectRoleAdmin, nil
	}

	// Verify user is an active member of the parent team
	teamMember, err := s.teamRepo.GetMember(ctx, project.TeamID, user.ID)
	if err != nil {
		return nil, "", ErrForbidden
	}

	// If team admin, automatically project admin
	if teamMember.Role == domain.TeamRoleAdmin {
		return project, domain.ProjectRoleAdmin, nil
	}

	// Check explicit project membership
	member, err := s.projectRepo.GetMember(ctx, projectID, user.ID)
	if err != nil {
		return nil, "", ErrForbidden
	}

	return project, member.Role, nil
}
