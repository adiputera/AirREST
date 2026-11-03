package service_test

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestConcurrentSuperadminBootstrap simulates cold starts racing to create the initial
// superadmin on an empty database; every instance must succeed and exactly one account must exist.
func TestConcurrentSuperadminBootstrap(t *testing.T) {
	databaseURL := os.Getenv("AIRREST_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set AIRREST_TEST_DATABASE_URL to a disposable local PostgreSQL database ending in _test")
	}
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || !strings.HasSuffix(u.Path, "_test") {
		t.Fatal("integration tests require a disposable localhost database ending in _test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	control, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	schema := "bootstrap_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := control.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := control.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
	}()
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()

	pool, err := postgres.ConnectWithPoolConfig(ctx, u.String(), 8, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	auth := service.NewAuthService(postgres.NewUserRepository(pool), nil)
	password := "test-bootstrap-" + uuid.NewString()

	const instances = 5
	start := make(chan struct{})
	errs := make(chan error, instances)
	var wg sync.WaitGroup
	for range instances {
		wg.Go(func() {
			<-start
			errs <- auth.BootstrapSuperadmin(ctx, "admin@example.com", password, "Super Administrator")
		})
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent bootstrap failed: %v", err)
		}
	}

	var admins int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM users WHERE role = 'superadmin'").Scan(&admins); err != nil {
		t.Fatal(err)
	}
	if admins != 1 {
		t.Fatalf("expected exactly 1 superadmin, got %d", admins)
	}
}

