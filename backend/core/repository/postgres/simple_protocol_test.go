package postgres

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestSimpleProtocolUUIDArrayEncoding(t *testing.T) {
	m := pgtype.NewMap()
	ids := []string{uuid.NewString(), uuid.NewString()}

	// Simple protocol (OID 0, text format) used by poolers (Neon/Supabase/PgBouncer)
	buf, err := m.Encode(0, pgtype.TextFormatCode, ids, []byte{})
	if err != nil {
		t.Fatalf("failed to encode []string for simple protocol (OID 0): %v", err)
	}
	if len(buf) == 0 || buf[0] != '{' || buf[len(buf)-1] != '}' {
		t.Fatalf("unexpected simple protocol array literal: %q", string(buf))
	}

	// Extended protocol with $N::text[]::uuid[] (Postgres describes param as text[] / OID 1009)
	if _, err := m.Encode(pgtype.TextArrayOID, pgtype.TextFormatCode, ids, []byte{}); err != nil {
		t.Fatalf("failed to encode []string for text[] text format: %v", err)
	}
	if _, err := m.Encode(pgtype.TextArrayOID, pgtype.BinaryFormatCode, ids, []byte{}); err != nil {
		t.Fatalf("failed to encode []string for text[] binary format: %v", err)
	}
}

// Guards against passing raw []uuid.UUID into ANY($N), which fails at runtime under
// pgx.QueryExecModeSimpleProtocol (OID 0 has no encode plan for []uuid.UUID).
func TestPostgresRepoQueriesAvoidRawUUIDArrayAny(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("failed to read postgres repository directory: %v", err)
	}
	rawAnyPattern := regexp.MustCompile(`(?i)ANY\s*\(\s*\$\d+\s*\)`)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		data, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("failed to read %s: %v", name, err)
		}
		if match := rawAnyPattern.FindString(string(data)); match != "" {
			t.Errorf("%s uses untyped %q; use ANY($N::text[]::uuid[]) with []string for pgx.QueryExecModeSimpleProtocol compatibility", name, match)
		}
	}
}
