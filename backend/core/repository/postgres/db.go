package postgres

import (
	"context"
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

// Connect connects to PostgreSQL with default pool settings and runs migrations
func Connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return ConnectWithPoolConfig(ctx, databaseURL, 25, 2, false)
}

// ConnectWithPoolConfig connects to PostgreSQL with custom pool bounds and optional migration bypass
func ConnectWithPoolConfig(ctx context.Context, databaseURL string, maxConns, minConns int, skipMigrations bool) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database config: %w", err)
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
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	// Ping database with timeout
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	slog.Info("connected to PostgreSQL successfully", "max_conns", maxConns, "min_conns", minConns)

	// Run migrations if not skipped
	if skipMigrations {
		slog.Info("skipping database migrations (skipMigrations=true)")
	} else {
		if err := runMigrations(ctx, pool); err != nil {
			pool.Close()
			return nil, fmt.Errorf("failed to apply migrations: %w", err)
		}
	}

	return pool, nil
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := fs.ReadDir(migrations.MigrationFS, ".")
	if err != nil {
		return fmt.Errorf("failed to read migration files: %w", err)
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		slog.Info("executing migration", "file", entry.Name())
		content, err := fs.ReadFile(migrations.MigrationFS, entry.Name())
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", entry.Name(), err)
		}

		if _, err := pool.Exec(ctx, string(content)); err != nil {
			return fmt.Errorf("failed to execute migration %s: %w", entry.Name(), err)
		}
	}

	slog.Info("all database migrations applied successfully")
	return nil
}
