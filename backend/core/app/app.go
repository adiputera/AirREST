package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/adiputera/airrest-backend/config"
	"github.com/adiputera/airrest-backend/core/handler"
	"github.com/adiputera/airrest-backend/core/middleware"
	"github.com/adiputera/airrest-backend/core/repository/postgres"
	"github.com/adiputera/airrest-backend/core/service"
	"github.com/adiputera/airrest-backend/pkg/response"
	"github.com/adiputera/airrest-backend/pkg/token"
	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
)

// App encapsulates runtime configuration, database connection, and routing logic
type App struct {
	Config *config.Config
	Pool   *pgxpool.Pool
	Router chi.Router
}

// New initializes the entire AirREST backend application stack
func New(ctx context.Context) (*App, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("failed to load configuration: %w", err)
	}

	pool, err := postgres.ConnectWithPoolConfig(
		ctx,
		cfg.DatabaseURL,
		cfg.DBMaxConns,
		cfg.DBMinConns,
		cfg.SkipMigrations,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize database pool: %w", err)
	}

	// Initialize Repositories
	userRepo := postgres.NewUserRepository(pool)
	workspaceRepo := postgres.NewWorkspaceRepository(pool)
	teamRepo := postgres.NewTeamRepository(pool)
	projectRepo := postgres.NewProjectRepository(pool)
	collectionRepo := postgres.NewCollectionRepository(pool)
	envRepo := postgres.NewEnvironmentRepository(pool)

	// Initialize Services
	tokenManager := token.NewTokenManager(cfg.JWTSecret, cfg.JWTExpirationHours, cfg.JWTRefreshExpirationDays)
	authService := service.NewAuthService(userRepo, tokenManager)
	workspaceService := service.NewWorkspaceService(workspaceRepo)
	teamService := service.NewTeamService(teamRepo, userRepo)
	projectService := service.NewProjectService(projectRepo, teamRepo, teamService)
	collectionService := service.NewCollectionService(collectionRepo, workspaceRepo, projectService)
	envService := service.NewEnvironmentService(envRepo, collectionService, projectService)
	syncService := service.NewSyncService(pool, collectionService, envService)

	// Bootstrap initial Superadmin if not exists
	bootstrapCtx, bootstrapCancel := context.WithTimeout(ctx, 10*time.Second)
	if err := authService.BootstrapSuperadmin(bootstrapCtx, cfg.SuperadminEmail, cfg.SuperadminPassword, cfg.SuperadminName); err != nil {
		slog.Warn("failed to bootstrap superadmin account", "error", err)
	}
	bootstrapCancel()

	// Initialize Handlers
	authHandler := handler.NewAuthHandler(authService)
	userHandler := handler.NewUserHandler(authService)
	adminHandler := handler.NewAdminHandler(authService)
	workspaceHandler := handler.NewWorkspaceHandler(workspaceService)
	teamHandler := handler.NewTeamHandler(teamService)
	projectHandler := handler.NewProjectHandler(projectService)
	collectionHandler := handler.NewCollectionHandler(collectionService)
	envHandler := handler.NewEnvironmentHandler(envService)
	syncHandler := handler.NewSyncHandler(syncService)

	// Build Chi Router
	r := chi.NewRouter()

	// Global Middlewares
	r.Use(chiMiddleware.Recoverer)
	r.Use(middleware.Logger)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Root Status and Health aliases (useful for direct ping / monitoring)
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		response.JSON(w, http.StatusOK, map[string]any{
			"service":    "AirREST Cloud API",
			"status":     "running",
			"serverless": cfg.IsServerless,
			"time":       time.Now().UTC().Format(time.RFC3339),
		})
	})

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		response.JSON(w, http.StatusOK, map[string]any{
			"status":     "healthy",
			"service":    "AirREST Cloud API",
			"serverless": cfg.IsServerless,
			"time":       time.Now().UTC().Format(time.RFC3339),
		})
	})

	// API Routes under /api/v1
	r.Route("/api/v1", func(r chi.Router) {
		// Health check
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			response.JSON(w, http.StatusOK, map[string]any{
				"status":     "healthy",
				"service":    "AirREST Cloud API",
				"serverless": cfg.IsServerless,
				"time":       time.Now().UTC().Format(time.RFC3339),
			})
		})

		// Public Auth
		r.Route("/auth", func(r chi.Router) {
			r.Post("/register", authHandler.Register)
			r.Post("/login", authHandler.Login)
			r.Post("/refresh", authHandler.Refresh)
		})

		// Authenticated Routes
		r.Group(func(r chi.Router) {
			r.Use(middleware.Authenticate(tokenManager, authService))

			// Auth profile & password management
			r.Get("/auth/me", authHandler.Me)
			r.Put("/auth/profile", authHandler.UpdateProfile)
			r.Put("/auth/password", authHandler.ChangePassword)

			// User lookup & search
			r.Route("/users", func(r chi.Router) {
				r.Get("/search", userHandler.Search)
			})

			// Workspaces
			r.Route("/workspaces", func(r chi.Router) {
				r.Get("/", workspaceHandler.List)
				r.Post("/", workspaceHandler.Create)
				r.Get("/{id}", workspaceHandler.Get)
				r.Put("/{id}", workspaceHandler.Update)
				r.Delete("/{id}", workspaceHandler.Delete)
			})

			// Teams
			r.Route("/teams", func(r chi.Router) {
				r.Get("/", teamHandler.List)
				r.Post("/", teamHandler.Create)
				r.Get("/{id}", teamHandler.Get)
				r.Put("/{id}", teamHandler.Update)
				r.Delete("/{id}", teamHandler.Delete)

				// Team members
				r.Get("/{id}/members", teamHandler.ListMembers)
				r.Post("/{id}/members", teamHandler.AddMember)
				r.Delete("/{id}/members/{userId}", teamHandler.RemoveMember)

				// Team projects
				r.Get("/{teamId}/projects", projectHandler.ListByTeam)
				r.Post("/{teamId}/projects", projectHandler.Create)
			})

			// Projects
			r.Route("/projects", func(r chi.Router) {
				r.Get("/{id}", projectHandler.Get)
				r.Put("/{id}", projectHandler.Update)
				r.Delete("/{id}", projectHandler.Delete)

				// Project members & isolation assignment
				r.Get("/{id}/members", projectHandler.ListMembers)
				r.Post("/{id}/members", projectHandler.AddMember)
				r.Delete("/{id}/members/{userId}", projectHandler.RemoveMember)
			})

			// Collections
			r.Route("/collections", func(r chi.Router) {
				r.Get("/", collectionHandler.List)
				r.Post("/", collectionHandler.Create)
				r.Get("/{id}", collectionHandler.Get)
				r.Put("/{id}", collectionHandler.Update)
				r.Delete("/{id}", collectionHandler.Delete)
				r.Put("/{id}/reorder", collectionHandler.ReorderItems)
				r.Put("/{id}/items/reorder", collectionHandler.ReorderItems)
			})

			// Collection Items (Folders & Requests)
			r.Route("/items", func(r chi.Router) {
				r.Post("/", collectionHandler.CreateItem)
				r.Get("/{id}", collectionHandler.GetItem)
				r.Put("/{id}", collectionHandler.UpdateItem)
				r.Delete("/{id}", collectionHandler.DeleteItem)
			})

			// Environments
			r.Route("/environments", func(r chi.Router) {
				r.Get("/", envHandler.List)
				r.Post("/", envHandler.Create)
				r.Get("/{id}", envHandler.Get)
				r.Put("/{id}", envHandler.Update)
				r.Delete("/{id}", envHandler.Delete)
			})

			// Stateless Delta Sync
			r.Route("/sync", func(r chi.Router) {
				r.Get("/pull", syncHandler.Pull)
				r.Post("/push", syncHandler.Push)
				r.Post("/import-batch", syncHandler.ImportBatch)
			})

			// Superadmin User Management
			r.Route("/admin", func(r chi.Router) {
				r.Use(middleware.RequireSuperadmin)
				r.Get("/users", adminHandler.ListUsers)
				r.Post("/users", adminHandler.CreateUser)
				r.Put("/users/{userId}/password", adminHandler.ResetUserPassword)
			})
		})
	})

	return &App{
		Config: cfg,
		Pool:   pool,
		Router: r,
	}, nil
}

// Close gracefully closes the underlying database pool
func (a *App) Close() {
	if a.Pool != nil {
		a.Pool.Close()
	}
}
