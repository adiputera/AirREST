package config

import (
	"errors"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config holds runtime application configuration
type Config struct {
	Port                     string
	DatabaseURL              string
	JWTSecret                string
	JWTExpirationHours       int
	JWTRefreshExpirationDays int
	SuperadminEmail          string
	SuperadminPassword       string
	SuperadminName           string
	DBMaxConns               int
	DBMinConns               int
	SkipMigrations           bool
	AllowedOrigins           []string
	IsServerless             bool
}

// Load loads environment variables into Config
func Load() (*Config, error) {
	_ = godotenv.Load() // Ignore error if .env doesn't exist

	isServerless := os.Getenv("VERCEL") != "" || os.Getenv("SERVERLESS") == "true"

	port := getEnv("PORT", "8080")
	dbURL := getEnv("DATABASE_URL", "postgres://airrest:airrest_secret_password@localhost:5432/airrest_db?sslmode=disable")
	jwtSecret := os.Getenv("JWT_SECRET")
	if err := ValidateJWTSecret(jwtSecret); err != nil {
		return nil, err
	}

	expHoursStr := getEnv("JWT_EXPIRATION_HOURS", "72")
	expHours, err := strconv.Atoi(expHoursStr)
	if err != nil {
		expHours = 72
	}

	expRefreshDaysStr := getEnv("JWT_REFRESH_EXPIRATION_DAYS", "30")
	expRefreshDays, err := strconv.Atoi(expRefreshDaysStr)
	if err != nil || expRefreshDays <= 0 {
		expRefreshDays = 30
	}

	superEmail := os.Getenv("SUPERADMIN_EMAIL")
	superPassword := os.Getenv("SUPERADMIN_PASSWORD")
	superName := getEnv("SUPERADMIN_NAME", "Super Administrator")

	// Serverless-friendly DB connection pooling
	defaultMaxConns := 25
	defaultMinConns := 2
	if isServerless {
		defaultMaxConns = 4
		defaultMinConns = 1
	}

	maxConns := defaultMaxConns
	if val := os.Getenv("DB_MAX_CONNS"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			maxConns = parsed
		}
	}

	minConns := defaultMinConns
	if val := os.Getenv("DB_MIN_CONNS"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed >= 0 {
			minConns = parsed
		}
	}

	if minConns > maxConns {
		minConns = maxConns
	}
	skipMigrations := os.Getenv("SKIP_MIGRATIONS") == "true" || os.Getenv("SKIP_MIGRATIONS") == "1"

	return &Config{
		Port:                     port,
		DatabaseURL:              dbURL,
		JWTSecret:                jwtSecret,
		JWTExpirationHours:       expHours,
		JWTRefreshExpirationDays: expRefreshDays,
		SuperadminEmail:          superEmail,
		SuperadminPassword:       superPassword,
		SuperadminName:           superName,
		DBMaxConns:               maxConns,
		DBMinConns:               minConns,
		SkipMigrations:           skipMigrations,
		AllowedOrigins:           []string{"http://localhost:*", "http://127.0.0.1:*", "https://*"},
		IsServerless:             isServerless,
	}, nil
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

// ValidateJWTSecret rejects absent, example, and obviously weak signing keys.
// Generate a random value (for example, openssl rand -hex 32); length alone is not entropy.
func ValidateJWTSecret(secret string) error {
	unique := make(map[rune]bool)
	for _, c := range secret {
		unique[c] = true
	}
	lower := strings.ToLower(secret)
	if len(secret) < 32 || len(unique) < 12 || strings.TrimSpace(secret) != secret {
		return errors.New("JWT_SECRET must be a randomly generated key of at least 32 characters")
	}
	for size := 1; size <= len(secret)/2; size++ {
		if len(secret)%size == 0 && strings.Repeat(secret[:size], len(secret)/size) == secret {
			return errors.New("JWT_SECRET must not be a repeating pattern")
		}
	}
	for _, example := range []string{"default", "example", "change-in-production", "change-me", "changeme", "super-secret"} {
		if strings.Contains(lower, example) {
			return errors.New("JWT_SECRET must not be an example key")
		}
	}
	return nil
}
