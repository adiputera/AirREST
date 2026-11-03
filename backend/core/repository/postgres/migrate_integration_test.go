package postgres

import (
	"context"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// isolatedTestSchema creates a disposable schema on AIRREST_TEST_DATABASE_URL and returns a
// connection string scoped to it. The test is skipped when no test database is configured.
func isolatedTestSchema(t *testing.T) string {
	t.Helper()
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	control, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "migrate_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := control.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		control.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := control.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		control.Close()
	})
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String()
}

// TestConcurrentMigrationsApplyEachVersionOnce simulates several cold-start instances racing
// to migrate the same database, which previously failed with schema_migrations_pkey violations.
func TestConcurrentMigrationsApplyEachVersionOnce(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	fsys := fstest.MapFS{
		"001_create.sql": {Data: []byte("CREATE TABLE race_items (id INT PRIMARY KEY); SELECT pg_sleep(0.3);")},
		// Not idempotent: a duplicate execution would raise a unique violation.
		"002_seed.sql":  {Data: []byte("INSERT INTO race_items (id) VALUES (1);")},
		"003_alter.sql": {Data: []byte("ALTER TABLE race_items ADD COLUMN name TEXT;")},
		"README.md":     {Data: []byte("ignored")},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	const instances = 6
	pools := make([]*pgxpool.Pool, instances)
	for i := range pools {
		p, err := pgxpool.New(ctx, scopedURL)
		if err != nil {
			t.Fatal(err)
		}
		pools[i] = p
		defer p.Close()
	}

	start := make(chan struct{})
	errs := make(chan error, instances)
	var wg sync.WaitGroup
	for _, p := range pools {
		wg.Go(func() {
			<-start
			errs <- runMigrationsFS(ctx, p, fsys)
		})
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent migration failed: %v", err)
		}
	}

	var versions, rows int
	if err := pools[0].QueryRow(ctx, "SELECT COUNT(*) FROM schema_migrations").Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if err := pools[0].QueryRow(ctx, "SELECT COUNT(*) FROM race_items").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if versions != 3 || rows != 1 {
		t.Fatalf("expected 3 recorded versions and 1 seeded row, got %d versions and %d rows", versions, rows)
	}

	// A later boot must be a no-op.
	if err := runMigrationsFS(ctx, pools[0], fsys); err != nil {
		t.Fatalf("re-run failed: %v", err)
	}
}

// TestMigrationLockTimeoutFailsFast verifies that DDL waiting on a table lock held by live
// traffic aborts after lock_timeout instead of blocking indefinitely.
func TestMigrationLockTimeoutFailsFast(t *testing.T) {
	scopedURL := isolatedTestSchema(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, scopedURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	if err := runMigrationsFS(ctx, pool, fstest.MapFS{
		"001_create.sql": {Data: []byte("CREATE TABLE busy (id INT);")},
	}); err != nil {
		t.Fatal(err)
	}

	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(context.Background()) }()
	if _, err := holder.Exec(ctx, "LOCK TABLE busy IN ACCESS SHARE MODE"); err != nil {
		t.Fatal(err)
	}

	began := time.Now()
	err = runMigrationsFS(ctx, pool, fstest.MapFS{
		"001_create.sql": {Data: []byte("CREATE TABLE busy (id INT);")},
		"002_alter.sql":  {Data: []byte("ALTER TABLE busy ADD COLUMN name TEXT;")},
	})
	if err == nil {
		t.Fatal("expected lock_timeout failure while table is locked")
	}
	if elapsed := time.Since(began); elapsed > 15*time.Second {
		t.Fatalf("migration waited %s; lock_timeout not applied", elapsed)
	}
	if !strings.Contains(err.Error(), "lock timeout") {
		t.Fatalf("expected lock timeout error, got %v", err)
	}
}

