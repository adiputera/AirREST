package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/adiputera/airrest-backend/core/app"
)

func main() {
	// 1. Setup structured JSON logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	slog.Info("starting AirREST backend service...")

	// 2. Initialize application stack
	initCtx, initCancel := context.WithTimeout(context.Background(), 25*time.Second)
	application, err := app.New(initCtx)
	initCancel()
	if err != nil {
		slog.Error("failed to initialize AirREST backend", "error", err)
		os.Exit(1)
	}
	defer application.Close()

	// 3. Configure HTTP Server
	server := &http.Server{
		Addr:         fmt.Sprintf(":%s", application.Config.Port),
		Handler:      application.Router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// 4. Start HTTP Server in background
	go func() {
		slog.Info("server listening on", "port", application.Config.Port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed to start", "error", err)
			os.Exit(1)
		}
	}()

	// 5. Listen for OS termination signals
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down server gracefully...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("server forced to shutdown", "error", err)
	}

	slog.Info("server exited safely")
}
