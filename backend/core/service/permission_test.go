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
	colService := NewCollectionService(nil, nil, nil, nil)

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
	colService := NewCollectionService(nil, nil, nil, nil)

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

func TestCollectionMinRoleAccessRules(t *testing.T) {
	// 1. CanAccessCollection role hierarchy verification
	roles := []domain.ProjectRole{
		domain.ProjectRoleReader,
		domain.ProjectRoleContributor,
		domain.ProjectRoleMaintainer,
		domain.ProjectRoleAdmin,
	}

	for i, userRole := range roles {
		for j, minRole := range roles {
			expected := i >= j
			actual := CanAccessCollection(userRole, minRole)
			if actual != expected {
				t.Fatalf("CanAccessCollection(%s, %s): expected %v, got %v", userRole, minRole, expected, actual)
			}
		}
	}
}

func TestRolePermissionsMapping(t *testing.T) {
	adminPerms := domain.GetPermissionsForRole(domain.ProjectRoleAdmin)
	if !domain.HasPermission(adminPerms, "collection:write") || !domain.HasPermission(adminPerms, "env:delete") {
		t.Fatalf("admin wildcard should allow all permissions, got %v", adminPerms)
	}

	maintainerPerms := domain.GetPermissionsForRole(domain.ProjectRoleMaintainer)
	if !domain.HasPermission(maintainerPerms, "collection:delete") || !domain.HasPermission(maintainerPerms, "env:delete") {
		t.Fatalf("maintainer should have collection:delete and env:delete, got %v", maintainerPerms)
	}

	contributorPerms := domain.GetPermissionsForRole(domain.ProjectRoleContributor)
	if !domain.HasPermission(contributorPerms, "collection:write") || !domain.HasPermission(contributorPerms, "env:write") {
		t.Fatalf("contributor should have collection:write and env:write, got %v", contributorPerms)
	}
	if domain.HasPermission(contributorPerms, "collection:delete") || domain.HasPermission(contributorPerms, "env:delete") {
		t.Fatalf("contributor should NOT have delete permissions, got %v", contributorPerms)
	}

	readerPerms := domain.GetPermissionsForRole(domain.ProjectRoleReader)
	if !domain.HasPermission(readerPerms, "collection:read") || !domain.HasPermission(readerPerms, "env:read") {
		t.Fatalf("reader should have read permissions, got %v", readerPerms)
	}
	if domain.HasPermission(readerPerms, "collection:write") || domain.HasPermission(readerPerms, "env:write") {
		t.Fatalf("reader should NOT have write permissions, got %v", readerPerms)
	}
}


