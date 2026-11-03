package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/adiputera/airrest-backend/config"
	"github.com/adiputera/airrest-backend/core/app"
)

// errInitializing is returned while another request is performing initialization.
var errInitializing = errors.New("initialization in progress")

type appInitializer struct {
	mu           sync.Mutex
	application  *app.App
	initializing bool
	retryAt      time.Time
	failures     uint
	lastErr      error
	timeout      time.Duration
	initialize   func(context.Context) (*app.App, error)
	now          func() time.Time
}

var runtimeApp = &appInitializer{initialize: app.New, now: time.Now, timeout: config.InitTimeout()}

// get permits one attempt at a time and caches only successful initialization.
func (s *appInitializer) get(ctx context.Context) (*app.App, error) {
	s.mu.Lock()
	if s.application != nil {
		a := s.application
		s.mu.Unlock()
		return a, nil
	}
	if s.initializing {
		s.mu.Unlock()
		return nil, errInitializing
	}
	if s.now().Before(s.retryAt) {
		lastErr := s.lastErr
		s.mu.Unlock()
		return nil, fmt.Errorf("initialization backing off: %w", lastErr)
	}
	s.initializing = true
	s.mu.Unlock()
	timeout := s.timeout
	if timeout <= 0 {
		timeout = config.StartupTimeout
	}
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	a, err := s.initialize(initCtx)
	if err == nil && a == nil {
		err = fmt.Errorf("initializer returned no application")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initializing = false
	if err != nil {
		if a != nil && a.Pool != nil {
			a.Pool.Close()
		}
		delay := time.Second << min(s.failures, 5)
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		if s.failures < 5 {
			s.failures++
		}
		s.retryAt = s.now().Add(delay)
		s.lastErr = err
		slog.Error("failed to initialize backend", "error", err, "retry_after", delay)
		return nil, err
	}
	s.application = a
	s.failures = 0
	s.lastErr = nil
	return a, nil
}

func init() {
	// Configure structured JSON logging for Vercel Log Streams
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
}

// Handler is the Vercel Serverless Function HTTP entry point
func Handler(w http.ResponseWriter, r *http.Request) {
	application, initErr := runtimeApp.get(r.Context())

	if initErr != nil {
		writeInitError(w, initErr)
		return
	}

	// On Vercel, rewrites can overwrite r.URL.Path with the internal destination (/api/index.go).
	// Restore the original client request path from Vercel routing headers if present.
	if matchedPath := r.Header.Get("x-matched-path"); matchedPath != "" {
		r.URL.Path = matchedPath
	} else if invokePath := r.Header.Get("x-invoke-path"); invokePath != "" {
		r.URL.Path = invokePath
	}

	// Forward incoming request to the Chi router
	application.Router.ServeHTTP(w, r)
}

// initFailure is the nested error object returned while the backend cannot initialize.
type initFailure struct {
	Code    string `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// describeInitError maps an initialization error to a client-safe reason and message.
// Raw errors stay in server logs only.
func describeInitError(err error) (string, string) {
	if errors.Is(err, errInitializing) {
		return "INITIALIZING", "Service is initializing, retry shortly"
	}
	switch app.StageOf(err) {
	case app.StageConfig:
		return string(app.StageConfig), "Server configuration is invalid"
	case app.StageDatabase:
		return string(app.StageDatabase), "Failed to initialize database connection"
	case app.StageMigration:
		return string(app.StageMigration), "Database migration failed"
	case app.StageBootstrap:
		return string(app.StageBootstrap), "Initial administrator bootstrap failed"
	default:
		return "INITIALIZATION_FAILED", "Service initialization failed"
	}
}

// writeInitError writes the 503 SERVICE_UNAVAILABLE envelope for initialization failures.
func writeInitError(w http.ResponseWriter, err error) {
	reason, message := describeInitError(err)
	body, _ := json.Marshal(map[string]any{
		"success": false,
		"error":   initFailure{Code: "SERVICE_UNAVAILABLE", Reason: reason, Message: message},
	})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "1")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write(body)
}
