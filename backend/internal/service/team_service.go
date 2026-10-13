package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/adiputera/airrest-backend/internal/domain"
	"github.com/adiputera/airrest-backend/internal/repository/postgres"
	"github.com/google/uuid"
)

var (
	ErrSuperadminRequired = errors.New("superadmin access required")
	ErrTeamAdminRequired  = errors.New("team admin access required")
	ErrForbidden          = errors.New("forbidden")
)

type TeamService struct {
	teamRepo *postgres.TeamRepository
	userRepo *postgres.UserRepository
}

func NewTeamService(teamRepo *postgres.TeamRepository, userRepo *postgres.UserRepository) *TeamService {
	return &TeamService{
		teamRepo: teamRepo,
		userRepo: userRepo,
	}
}

// CreateTeam can only be executed by Superadmin
func (s *TeamService) CreateTeam(ctx context.Context, user *domain.User, name, description string) (*domain.Team, error) {
	if !user.IsSuperadmin() {
		return nil, ErrSuperadminRequired
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("team name is required")
	}

	var desc *string
	if description != "" {
		desc = &description
	}

	team := &domain.Team{
		ID:          uuid.New(),
		Name:        name,
		Description: desc,
		CreatedBy:   user.ID,
	}

	if err := s.teamRepo.Create(ctx, team); err != nil {
		return nil, err
	}

	// Add creator as Team Admin
	_ = s.teamRepo.AddMember(ctx, &domain.TeamMember{
		ID:     uuid.New(),
		TeamID: team.ID,
		UserID: user.ID,
		Role:   domain.TeamRoleAdmin,
	})

	return team, nil
}

// UpdateTeam can only be executed by Superadmin
func (s *TeamService) UpdateTeam(ctx context.Context, user *domain.User, id uuid.UUID, name, description string) (*domain.Team, error) {
	if !user.IsSuperadmin() {
		return nil, ErrSuperadminRequired
	}

	team, err := s.teamRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	name = strings.TrimSpace(name)
	if name != "" {
		team.Name = name
	}
	if description != "" {
		team.Description = &description
	}

	if err := s.teamRepo.Update(ctx, team); err != nil {
		return nil, err
	}
	return team, nil
}

// DeleteTeam can only be executed by Superadmin
func (s *TeamService) DeleteTeam(ctx context.Context, user *domain.User, id uuid.UUID) error {
	if !user.IsSuperadmin() {
		return ErrSuperadminRequired
	}
	return s.teamRepo.Delete(ctx, id)
}

// ListTeams returns teams accessible to user
func (s *TeamService) ListTeams(ctx context.Context, user *domain.User) ([]*domain.Team, error) {
	return s.teamRepo.ListForUser(ctx, user.ID, user.IsSuperadmin())
}

// GetTeam returns team if user has access
func (s *TeamService) GetTeam(ctx context.Context, user *domain.User, id uuid.UUID) (*domain.Team, error) {
	if !user.IsSuperadmin() {
		// Check membership
		_, err := s.teamRepo.GetMember(ctx, id, user.ID)
		if err != nil {
			return nil, ErrForbidden
		}
	}
	return s.teamRepo.GetByID(ctx, id)
}

// CheckIfTeamAdmin returns true if user is superadmin or team admin
func (s *TeamService) CheckIfTeamAdmin(ctx context.Context, user *domain.User, teamID uuid.UUID) (bool, error) {
	if user.IsSuperadmin() {
		return true, nil
	}
	member, err := s.teamRepo.GetMember(ctx, teamID, user.ID)
	if err != nil {
		return false, nil
	}
	return member.Role == domain.TeamRoleAdmin, nil
}

// AddMember adds or updates member in team (executed by Superadmin or Team Admin)
func (s *TeamService) AddMember(ctx context.Context, user *domain.User, teamID, targetUserID uuid.UUID, role domain.TeamRole) error {
	isAdmin, err := s.CheckIfTeamAdmin(ctx, user, teamID)
	if err != nil || !isAdmin {
		return ErrTeamAdminRequired
	}

	// Verify target user exists
	if _, err := s.userRepo.GetByID(ctx, targetUserID); err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	return s.teamRepo.AddMember(ctx, &domain.TeamMember{
		TeamID: teamID,
		UserID: targetUserID,
		Role:   role,
	})
}

// RemoveMember removes a member from team (executed by Superadmin or Team Admin)
func (s *TeamService) RemoveMember(ctx context.Context, user *domain.User, teamID, targetUserID uuid.UUID) error {
	isAdmin, err := s.CheckIfTeamAdmin(ctx, user, teamID)
	if err != nil || !isAdmin {
		return ErrTeamAdminRequired
	}

	return s.teamRepo.RemoveMember(ctx, teamID, targetUserID)
}

// ListMembers lists members in a team
func (s *TeamService) ListMembers(ctx context.Context, user *domain.User, teamID uuid.UUID) ([]*domain.TeamMember, error) {
	if !user.IsSuperadmin() {
		_, err := s.teamRepo.GetMember(ctx, teamID, user.ID)
		if err != nil {
			return nil, ErrForbidden
		}
	}
	return s.teamRepo.ListMembers(ctx, teamID)
}
