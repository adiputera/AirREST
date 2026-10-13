package handler

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/adiputera/airrest-backend/internal/app"
)

var (
	application *app.App
	initErr     error
	once        sync.Once
)

func init() {
	// Configure structured JSON logging for Vercel Log Streams
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
}

// Handler is the Vercel Serverless Function HTTP entry point
func Handler(w http.ResponseWriter, r *http.Request) {
	// Initialize on first cold-start invocation; reuse for subsequent warm requests
	once.Do(func() {
		slog.Info("initializing AirREST backend on Vercel serverless cold start...")
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		application, initErr = app.New(ctx)
		if initErr != nil {
			slog.Error("failed to initialize backend app on Vercel", "error", initErr)
		} else {
			slog.Info("AirREST backend initialized successfully on Vercel")
		}
	})

	if initErr != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Failed to initialize database connection"}}`))
		return
	}

	// Forward incoming request to the Chi router
	application.Router.ServeHTTP(w, r)
}
