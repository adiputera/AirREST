package service

import (
	"context"
	"testing"

	"github.com/adiputera/airrest-backend/core/domain"
	"github.com/google/uuid"
)

func TestSuperadminTeamRules(t *testing.T) {
	teamService := NewTeamService(nil, nil)

	regularUser := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleUser,
	}

	superadmin := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleSuperadmin,
	}

	ctx := context.Background()

	// 1. Regular user (even team admin) cannot delete team
	err := teamService.DeleteTeam(ctx, regularUser, uuid.New())
	if err != ErrSuperadminRequired {
		t.Fatalf("expected ErrSuperadminRequired when regular user deletes team, got: %v", err)
	}

	// 2. Regular user cannot create team
	_, err = teamService.CreateTeam(ctx, regularUser, "Team A", "desc")
	if err != ErrSuperadminRequired {
		t.Fatalf("expected ErrSuperadminRequired when regular user creates team, got: %v", err)
	}

	// 3. Regular user cannot update team
	_, err = teamService.UpdateTeam(ctx, regularUser, uuid.New(), "Team A", "desc")
	if err != ErrSuperadminRequired {
		t.Fatalf("expected ErrSuperadminRequired when regular user updates team, got: %v", err)
	}

	// 4. Superadmin passes the permission check on delete team
	// (will fail later on nil repo, but must NOT fail with ErrSuperadminRequired)
	defer func() {
		_ = recover() // Catch nil repo call if reached
	}()
	err = teamService.DeleteTeam(ctx, superadmin, uuid.New())
	if err == ErrSuperadminRequired {
		t.Fatalf("superadmin should not get ErrSuperadminRequired")
	}
}

func TestCollectionPermissionRules(t *testing.T) {
	colService := NewCollectionService(nil, nil, nil)

	superadmin := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleSuperadmin,
	}

	ctx := context.Background()
	wsID := uuid.New()
	projID := uuid.New()

	// 1. Superadmin has universal bypass on read and write
	if err := colService.CheckPermission(ctx, superadmin, &wsID, nil, true); err != nil {
		t.Fatalf("expected superadmin to have write access, got: %v", err)
	}
	if err := colService.CheckPermission(ctx, superadmin, nil, &projID, true); err != nil {
		t.Fatalf("expected superadmin to have project write access, got: %v", err)
	}
}

func TestReorderItemPermissionRules(t *testing.T) {
	colService := NewCollectionService(nil, nil, nil)

	superadmin := &domain.User{
		ID:   uuid.New(),
		Role: domain.RoleSuperadmin,
	}

	ctx := context.Background()
	wsID := uuid.New()

	// Superadmin has permission to reorder items in workspace
	if err := colService.CheckPermission(ctx, superadmin, &wsID, nil, true); err != nil {
		t.Fatalf("expected superadmin to have reorder write access, got: %v", err)
	}
}

func TestEnvironmentAccessRules(t *testing.T) {
	// 1. Reader role
	if !CanAccessEnv(domain.ProjectRoleReader, domain.ProjectRoleReader) {
		t.Fatalf("reader should be able to access reader-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleReader, domain.ProjectRoleContributor) {
		t.Fatalf("reader should NOT be able to access contributor-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleReader, domain.ProjectRoleMaintainer) {
		t.Fatalf("reader should NOT be able to access maintainer-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleReader, domain.ProjectRoleAdmin) {
		t.Fatalf("reader should NOT be able to access admin-level environment")
	}

	// 2. Contributor role
	if !CanAccessEnv(domain.ProjectRoleContributor, domain.ProjectRoleReader) {
		t.Fatalf("contributor should be able to access reader-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleContributor, domain.ProjectRoleContributor) {
		t.Fatalf("contributor should be able to access contributor-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleContributor, domain.ProjectRoleMaintainer) {
		t.Fatalf("contributor should NOT be able to access maintainer-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleContributor, domain.ProjectRoleAdmin) {
		t.Fatalf("contributor should NOT be able to access admin-level environment")
	}

	// 3. Maintainer role
	if !CanAccessEnv(domain.ProjectRoleMaintainer, domain.ProjectRoleReader) {
		t.Fatalf("maintainer should be able to access reader-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleMaintainer, domain.ProjectRoleContributor) {
		t.Fatalf("maintainer should be able to access contributor-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleMaintainer, domain.ProjectRoleMaintainer) {
		t.Fatalf("maintainer should be able to access maintainer-level environment")
	}
	if CanAccessEnv(domain.ProjectRoleMaintainer, domain.ProjectRoleAdmin) {
		t.Fatalf("maintainer should NOT be able to access admin-level environment")
	}

	// 4. Admin role
	if !CanAccessEnv(domain.ProjectRoleAdmin, domain.ProjectRoleReader) {
		t.Fatalf("admin should be able to access reader-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleAdmin, domain.ProjectRoleContributor) {
		t.Fatalf("admin should be able to access contributor-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleAdmin, domain.ProjectRoleMaintainer) {
		t.Fatalf("admin should be able to access maintainer-level environment")
	}
	if !CanAccessEnv(domain.ProjectRoleAdmin, domain.ProjectRoleAdmin) {
		t.Fatalf("admin should be able to access admin-level environment")
	}
}

