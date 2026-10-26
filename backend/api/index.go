package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/adiputera/airrest-backend/core/app"
)

type appInitializer struct {
	mu           sync.Mutex
	application  *app.App
	initializing bool
	retryAt      time.Time
	failures     uint
	initialize   func(context.Context) (*app.App, error)
	now          func() time.Time
}

var runtimeApp = &appInitializer{initialize: app.New, now: time.Now}

// get permits one attempt at a time and caches only successful initialization.
func (s *appInitializer) get(ctx context.Context) (*app.App, error) {
	s.mu.Lock()
	if s.application != nil {
		a := s.application
		s.mu.Unlock()
		return a, nil
	}
	if s.initializing || s.now().Before(s.retryAt) {
		s.mu.Unlock()
		return nil, fmt.Errorf("initialization pending or backing off")
	}
	s.initializing = true
	s.mu.Unlock()
	initCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
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
		slog.Error("failed to initialize backend", "error", err, "retry_after", delay)
		return nil, err
	}
	s.application = a
	s.failures = 0
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
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Failed to initialize database connection"}}`))
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
