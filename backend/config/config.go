package config

import (
	"os"
	"strconv"

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
	jwtSecret := getEnv("JWT_SECRET", "super-secret-default-jwt-key-minimum-32-chars")

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

	superEmail := getEnv("SUPERADMIN_EMAIL", "admin@example.com")
	superPassword := getEnv("SUPERADMIN_PASSWORD", "SuperadminSecurePassword123!")
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
