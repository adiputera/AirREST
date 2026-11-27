package config

import (
	"strings"
	"testing"
)

func TestSigningKeyValidation(t *testing.T) {
	for _, secret := range []string{"", "short", strings.Repeat("a", 64), strings.Repeat("0123456789abcdef", 4), "super-secret-default-jwt-key-minimum-32-chars", "super-secret-jwt-key-change-in-production-minimum-32-chars"} {
		if ValidateJWTSecret(secret) == nil {
			t.Errorf("accepted weak/example key")
		}
	}
	if err := ValidateJWTSecret("c72f384ab68ed95f20813ac4697e5db0a4629e31bf50867c1d8ab73946f205ee"); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRequiresExplicitKeyAndHasNoBootstrapDefaults(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("JWT_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("missing key accepted")
	}
	t.Setenv("JWT_SECRET", "c72f384ab68ed95f20813ac4697e5db0a4629e31bf50867c1d8ab73946f205ee")
	t.Setenv("SUPERADMIN_EMAIL", "")
	t.Setenv("SUPERADMIN_PASSWORD", "")
	t.Setenv("DB_MAX_CONNS", "1")
	t.Setenv("DB_MIN_CONNS", "2")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SuperadminEmail != "" || cfg.SuperadminPassword != "" {
		t.Fatal("bootstrap defaults remain")
	}
	if cfg.DBMinConns > cfg.DBMaxConns {
		t.Fatal("invalid pool bounds")
	}
	if cfg.JWTExpirationHours != 72 {
		t.Fatalf("expected default JWTExpirationHours 72, got %d", cfg.JWTExpirationHours)
	}
	if cfg.CORSAllowCredentials {
		t.Fatal("expected CORSAllowCredentials false by default without ALLOWED_ORIGINS")
	}

	t.Setenv("JWT_EXPIRATION_HOURS", "-5")
	t.Setenv("ALLOWED_ORIGINS", "https://hub.example.com, https://app.example.com")
	cfgCustom, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfgCustom.JWTExpirationHours != 72 {
		t.Fatalf("expected non-positive JWTExpirationHours to fallback to 72, got %d", cfgCustom.JWTExpirationHours)
	}
	if !cfgCustom.CORSAllowCredentials {
		t.Fatal("expected CORSAllowCredentials true when ALLOWED_ORIGINS is configured")
	}
	if len(cfgCustom.AllowedOrigins) != 2 || cfgCustom.AllowedOrigins[0] != "https://hub.example.com" || cfgCustom.AllowedOrigins[1] != "https://app.example.com" {
		t.Fatalf("unexpected AllowedOrigins: %#v", cfgCustom.AllowedOrigins)
	}
}
