# AirREST Backend Synchronization Service

> High-performance, lightweight Go backend for team collaboration, multi-workspace data synchronization, and fine-grained Role-Based Access Control (RBAC) in AirREST.

---

## 🚀 Overview

The AirREST Go backend provides cloud persistence and synchronization for AirREST while adhering to a lean, stateless REST architecture:
- **Zero WebSockets Overhead**: Synchronizes through 4 explicit triggers (app launch, item creation, manual save, and sync button).
- **Optimistic Concurrency Control (OCC)**: Validates `base_version` and returns `409 Conflict` with the latest remote version when concurrent edits occur.
- **Tombstone Deltas**: Soft deletes (`deleted_at`) ensure deleted requests never reappear as zombie items upon synchronization.
- **Hierarchical RBAC**: Strict separation between system-wide **Superadmin**, **Team Admin**, **Project Admin**, **Contributor**, and **Reader** roles.
- **Project Isolation**: Team members only see and access projects to which they are explicitly assigned; unassigned projects remain completely invisible.

---

## 🛠️ Tech Stack

- **Language**: Go 1.26
- **Routing**: [go-chi/chi/v5](https://github.com/go-chi/chi)
- **Database**: PostgreSQL 16 with [pgx/v5](https://github.com/jackc/pgx) connection pool
- **Authentication**: JWT (`golang-jwt/jwt/v5`) + `golang.org/x/crypto/bcrypt`
- **Migrations**: Embedded SQL schema migrations (`embed.FS`)

---

## ⚙️ Environment Variables & Security

> [!CAUTION]
> **Never commit `.env` or production secrets to Git!**
> Active `.env` files are ignored by git via `.gitignore` (`.env`, `.env.*`, `*.env`). Only sanitized template files like `.env.example` are tracked in version control. Always configure production secrets via your hosting provider's dashboard (e.g. Vercel Project Settings) or secure environment injection.

To configure local development, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### Configuration Reference

| Variable | Required | Default / Example | Purpose |
|---|---|---|---|
| `PORT` | Optional | `8080` | Port for the HTTP server to listen on. |
| `DATABASE_URL` | **Yes** | `postgres://airrest:airrest_secret_password@localhost:5432/airrest_db?sslmode=disable` | PostgreSQL connection string. For Vercel Serverless, use a pooled connection string with `?sslmode=require`. |
| `JWT_SECRET` | **Yes** | `super-secret-jwt-key-change-in-production-minimum-32-chars` | High-entropy signing key (minimum 32 characters) for HS256 JWT tokens. |
| `JWT_EXPIRATION_HOURS` | Optional | `72` | Access token lifespan in hours. |
| `JWT_REFRESH_EXPIRATION_DAYS` | Optional | `30` | Rolling refresh token lifespan in days. |
| `SUPERADMIN_EMAIL` | Optional | `admin@example.com` | Email for bootstrap Superadmin account created on first launch. |
| `SUPERADMIN_PASSWORD` | Optional | `SuperadminSecurePassword123!` | Password for bootstrap Superadmin account. |
| `SUPERADMIN_NAME` | Optional | `Super Administrator` | Display name for bootstrap Superadmin account. |
| `DB_MAX_CONNS` | Optional | `25` (Docker) / `4` (Vercel) | Maximum connections in `pgxpool`. |
| `DB_MIN_CONNS` | Optional | `2` (Docker) / `1` (Vercel) | Minimum idle connections in `pgxpool`. |
| `SKIP_MIGRATIONS` | Optional | `false` | Skip automatic boot schema migrations (useful if migrations are managed by external CI/CD). |


---

## 🐳 Quick Start with Docker

### 1. Start PostgreSQL
```bash
cd backend
docker compose up -d postgres
```

### 2. Run the Go Backend
```bash
go run cmd/server/main.go
```
The server will automatically apply all database migrations and bootstrap the initial Superadmin account if one does not already exist.

---

## ▲ Deploying to Vercel

The AirREST backend natively supports Vercel Serverless Functions via the `@vercel/go` runtime:

### 1. Vercel Project Configuration
1. In the [Vercel Dashboard](https://vercel.com/dashboard), click **Add New...** -> **Project** and import this repository.
2. In the **Configure Project** settings:
   - **Root Directory**: Click *Edit* and choose **`backend`**.
   - **Framework Preset**: Auto-detected as **Other** or **Go**.
3. Under **Environment Variables**, add:
   - `DATABASE_URL`: Cloud PostgreSQL connection string (see database recommendations below).
   - `JWT_SECRET`: Random 32+ character secret key.
   - `SUPERADMIN_EMAIL`: Initial Superadmin email (e.g. `admin@example.com`).
   - `SUPERADMIN_PASSWORD`: Strong password for the Superadmin account.
   - `SUPERADMIN_NAME`: Display name for the Superadmin.
4. Click **Deploy**.

### 2. How It Works on Vercel
- **Entrypoint**: `api/index.go` exports `func Handler(w http.ResponseWriter, r *http.Request)`.
- **Routing**: `vercel.json` rewrites all incoming traffic `/(.*)` to `/api/index.go`.
- **Serverless-Tuned Pooling**: When running on Vercel (`VERCEL=1`), `pgxpool` automatically switches to serverless-optimized bounds (`MaxConns: 4`, `MinConns: 1`) to maintain efficient PostgreSQL connection usage.
- **Cold-Start Lazy Init**: Database connections and router setup are initialized lazily on the first request via `sync.Once`. Subsequent warm requests process with zero setup overhead (< 5ms dispatch).

### 3. Recommended Cloud PostgreSQL
Because serverless functions scale dynamically, use a serverless-friendly PostgreSQL provider with transaction connection pooling:
- **Neon Serverless Postgres** (Native pooling, fast cold starts)
- **Supabase** (Use the Transaction Pooler connection string on port `6543`)
- **AWS Aurora Serverless / RDS with RDS Proxy**

---

## 🧪 Running Tests

```bash
cd backend
go test -v ./...
```

---

## 📡 REST API Reference

### Health & Auth
- `GET /api/v1/health` — Service healthcheck
- `POST /api/v1/auth/register` — Register a new user account (returns access token & 30-day rolling refresh token)
- `POST /api/v1/auth/login` — Authenticate and receive signed access token & 30-day rolling refresh token
- `POST /api/v1/auth/refresh` — Exchange valid refresh token for a fresh access token and renewed rolling refresh token
- `GET /api/v1/auth/me` — Get authenticated user profile (`Bearer <token>`)
- `PUT /api/v1/auth/profile` — Update user display name and avatar URL
- `PUT /api/v1/auth/password` — Change user password (verifies current password)

### User Directory & Search
- `GET /api/v1/users/search?email=...` — Search registered users by email or name (for team/project member assignment)

### Private Workspaces
- `GET /api/v1/workspaces` — List user's private workspaces
- `POST /api/v1/workspaces` — Create a new private workspace
- `GET /api/v1/workspaces/{id}` — Get workspace details
- `PUT /api/v1/workspaces/{id}` — Update workspace name/description
- `DELETE /api/v1/workspaces/{id}` — Delete private workspace (default workspace protected)

### Teams (Superadmin & Team Admin)
- `GET /api/v1/teams` — List accessible teams
- `POST /api/v1/teams` — Create team (*Superadmin only*)
- `GET /api/v1/teams/{id}` — Get team details
- `PUT /api/v1/teams/{id}` — Update team (*Superadmin only*)
- `DELETE /api/v1/teams/{id}` — Delete team (*Superadmin only*)
- `GET /api/v1/teams/{id}/members` — List team members
- `POST /api/v1/teams/{id}/members` — Add/update team member role (*Team Admin or Superadmin*)
- `DELETE /api/v1/teams/{id}/members/{userId}` — Remove member from team

### Projects & Project Isolation
- `GET /api/v1/teams/{teamId}/projects` — List projects visible to user (unassigned projects are hidden)
- `POST /api/v1/teams/{teamId}/projects` — Create project in team (*Team Admin or Superadmin*)
- `GET /api/v1/projects/{id}` — Get project details
- `PUT /api/v1/projects/{id}` — Update project
- `DELETE /api/v1/projects/{id}` — Delete project
- `GET /api/v1/projects/{id}/members` — List assigned project members
- `POST /api/v1/projects/{id}/members` — Assign user to project with role (`admin`, `contributor`, `reader`)
- `DELETE /api/v1/projects/{id}/members/{userId}` — Unassign member from project

### Collections & Items
- `GET /api/v1/collections?workspace_id={id}&project_id={id}` — List collections (automatically filtered by the caller's project role)
- `POST /api/v1/collections` — Create collection (supports `min_role: 'admin' | 'maintainer' | 'contributor' | 'reader'`)
- `GET /api/v1/collections/{id}` — Get collection and active items (enforces `min_role` RBAC)
- `PUT /api/v1/collections/{id}` — Update collection (supports `base_version` OCC and `min_role`)
- `POST /api/v1/collections/{id}/move` — Move collection between projects in the same team or between workspace and project (requires contributor+ role in source & target)
- `PUT /api/v1/collections/{id}/reorder` — Batch reorder and reparent folders and requests inside a collection
- `DELETE /api/v1/collections/{id}` — Soft delete collection (tombstone)
- `POST /api/v1/items` — Create request or folder item
- `GET /api/v1/items/{id}` — Get item details
- `PUT /api/v1/items/{id}` — Update item (returns `409 Conflict` + remote object if stale)
- `DELETE /api/v1/items/{id}` — Soft delete item (tombstone)

### Environments & Secrets
- `GET /api/v1/environments?workspace_id={id}&project_id={id}` — List scoped environments (automatically filtered by the caller's project role)
- `POST /api/v1/environments` — Create environment (supports `min_role: 'admin' | 'maintainer' | 'contributor' | 'reader'`)
- `GET /api/v1/environments/{id}` — Get environment details (enforces `min_role` RBAC)
- `PUT /api/v1/environments/{id}` — Update environment (supports `base_version` OCC and `min_role`)
- `DELETE /api/v1/environments/{id}` — Soft delete environment (tombstone)

### Stateless Delta & Batch Synchronization
- `GET /api/v1/sync/pull?workspace_id={id}&project_id={id}&since={timestamp}` — Pull additions, modifications, and tombstones
- `POST /api/v1/sync/push` — Batch push offline mutations with per-item OCC conflict reporting
- `POST /api/v1/sync/import-batch` — Claim and import existing offline LocalStorage collections into user's private workspace

### Superadmin Administration
- `GET /api/v1/admin/users` — List all registered users
- `POST /api/v1/admin/users` — Provision new user with custom role
- `PUT /api/v1/admin/users/{userId}/password` — Reset / change user password directly

---

## 📦 Quick Test in AirREST / Postman

A pre-configured collection is included: `backend/airrest_api_collection.json`.
1. Open AirREST (or Postman).
2. Click **Import** and select `backend/airrest_api_collection.json`.
3. Set your environment variable `baseUrl` to `http://localhost:8080`.
4. Run `Superadmin Login` — the authentication token will be automatically saved to your active environment!

