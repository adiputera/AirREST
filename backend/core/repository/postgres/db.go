package postgres

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/adiputera/airrest-backend/core/repository/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrDatabaseUnavailable marks failures to parse, open, or reach the configured database.
	ErrDatabaseUnavailable = errors.New("database unavailable")
	// ErrMigrationFailed marks failures while applying boot schema migrations.
	ErrMigrationFailed = errors.New("failed to apply migrations")
)

// Connect connects to PostgreSQL with default pool settings and runs migrations
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return ConnectWithPoolConfig(ctx, databaseURL, 25, 2, false)
}

// ConnectWithPoolConfig connects to PostgreSQL with custom pool bounds and optional migration bypass
func ConnectWithPoolConfig(ctx context.Context, databaseURL string, maxConns, minConns int, skipMigrations bool) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to parse database config: %w", ErrDatabaseUnavailable, err)
	}

	// In serverless environments or when connecting via transaction poolers (Neon pooler, Supabase port 6543, PgBouncer),
	// disable prepared statements by using QueryExecModeSimpleProtocol to avoid "prepared statement does not exist" errors
	if strings.Contains(databaseURL, "pooler") ||
		strings.Contains(databaseURL, ":6543") ||
		strings.Contains(databaseURL, "pgbouncer") ||
		strings.Contains(databaseURL, "neon.tech") ||
		strings.Contains(databaseURL, "supabase.co") ||
		strings.Contains(databaseURL, "supabase.net") {
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		slog.Info("cloud postgres / connection pooler detected: enabled pgx.QueryExecModeSimpleProtocol")
	}

	if maxConns <= 0 {
		maxConns = 4
	}
	config.MaxConns = int32(maxConns)
	config.MinConns = int32(minConns)
	config.MaxConnLifetime = 1 * time.Hour
	config.MaxConnIdleTime = 15 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create connection pool: %w", ErrDatabaseUnavailable, err)
	}

	// Ping database with timeout
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%w: failed to ping database: %w", ErrDatabaseUnavailable, err)
	}

	slog.Info("connected to PostgreSQL successfully", "max_conns", maxConns, "min_conns", minConns)

	// Run migrations if not skipped
	if skipMigrations {
		slog.Info("skipping database migrations (skipMigrations=true)")
	} else {
		if err := runMigrations(ctx, pool); err != nil {
			pool.Close()
			return nil, fmt.Errorf("%w: %w", ErrMigrationFailed, err)
		}
	}

	return pool, nil
}

const createSchemaMigrationsTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`

const (
	// migrationAdvisoryLockKey serializes migration work across every instance sharing a database.
	// Transaction-scoped advisory locks are released on commit/rollback, so they remain safe
	// behind transaction poolers (PgBouncer, Supabase port 6543, Neon pooler).
	migrationAdvisoryLockKey int64 = 0x41697252455354 // "AirREST"
	// migrationLockTimeout bounds waits for table locks taken by DDL so that a migration
	// fails fast instead of queueing live traffic behind an ACCESS EXCLUSIVE request.
	migrationLockTimeout = "5s"
	// migrationStatementTimeout bounds each migration file execution.
	migrationStatementTimeout = "60s"
)

// runMigrations applies embedded SQL migrations that are not yet recorded in schema_migrations.
func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	return runMigrationsFS(ctx, pool, migrations.MigrationFS)
}

// runMigrationsFS applies the migrations found in fsys in lexical order.
// Every step acquires the shared advisory lock and re-checks schema_migrations inside its own
// transaction, so concurrent cold starts apply each version exactly once.
func runMigrationsFS(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) error {
	if err := ensureSchemaMigrationsTable(ctx, pool); err != nil {
		return err
	}

	applied, err := appliedMigrations(ctx, pool)
	if err != nil {
		return err
	}

	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return fmt.Errorf("failed to read migration files: %w", err)
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") || applied[entry.Name()] {
			continue
		}
		content, err := fs.ReadFile(fsys, entry.Name())
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", entry.Name(), err)
		}
		if err := applyMigration(ctx, pool, entry.Name(), string(content)); err != nil {
			return err
		}
	}

	slog.Info("all database migrations up to date")
	return nil
}

// ensureSchemaMigrationsTable creates the tracking table under the advisory lock, because
// concurrent CREATE TABLE IF NOT EXISTS statements can still collide in the system catalogs.
func ensureSchemaMigrationsTable(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin schema_migrations transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationAdvisoryLockKey); err != nil {
		return fmt.Errorf("failed to acquire migration lock: %w", err)
	}
	if _, err := tx.Exec(ctx, createSchemaMigrationsTable); err != nil {
		return fmt.Errorf("failed to ensure schema_migrations table: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit schema_migrations table: %w", err)
	}
	return nil
}

// appliedMigrations returns a lock-free snapshot used only to skip known versions quickly.
func appliedMigrations(ctx context.Context, pool *pgxpool.Pool) (map[string]bool, error) {
	rows, err := pool.Query(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("failed to query schema_migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[string]bool)
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("failed to scan schema_migrations: %w", err)
		}
		applied[v] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read schema_migrations: %w", err)
	}
	return applied, nil
}

// applyMigration executes and records a single migration version atomically.
// It is a no-op when another instance recorded the same version while this one waited for the lock.
func applyMigration(ctx context.Context, pool *pgxpool.Pool, version, content string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin migration transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", migrationAdvisoryLockKey); err != nil {
		return fmt.Errorf("failed to acquire migration lock for %s: %w", version, err)
	}

	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&exists); err != nil {
		return fmt.Errorf("failed to check migration %s: %w", version, err)
	}
	if exists {
		slog.Info("database migration already applied by another instance", "file", version)
		return nil
	}

	// Timeouts are set after the advisory lock so that waiting for another instance is bounded
	// only by the caller context, while DDL table-lock waits fail fast.
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '"+migrationLockTimeout+"'"); err != nil {
		return fmt.Errorf("failed to set lock_timeout for %s: %w", version, err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '"+migrationStatementTimeout+"'"); err != nil {
		return fmt.Errorf("failed to set statement_timeout for %s: %w", version, err)
	}

	slog.Info("applying database migration", "file", version)
	if _, err := tx.Exec(ctx, content); err != nil {
		return fmt.Errorf("failed to execute migration %s: %w", version, err)
	}

	if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", version); err != nil {
		return fmt.Errorf("failed to record migration %s: %w", version, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit migration %s: %w", version, err)
	}
	return nil
}
