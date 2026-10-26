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

## 📜 API Contract & Multi-Language Re-Implementation

AirREST defines an explicit, technology-agnostic **API Contract** so anyone can re-implement the backend service in any programming language or framework (e.g. Node.js/TypeScript, Python, Java, C#, Rust, PHP) with 100% plug-and-play compatibility with both the Chrome Extension and Web Hub:

- **OpenAPI 3.1.0 Contract**: [`openapi.yaml`](openapi.yaml) and [`openapi.json`](openapi.json)
- **Detailed Re-Implementation Guide**: [`API_CONTRACT.md`](API_CONTRACT.md) (Complete guide on Envelope pattern, OCC, Tombstones, Silent Rolling Refresh, RBAC, and CORS)
- **Test Collection**: [`airrest_api_collection.json`](airrest_api_collection.json) (Postman / AirREST importable collection)
- **Code Generation**: Easily scaffold server interfaces via `@openapitools/openapi-generator-cli` for Spring Boot, FastAPI, NestJS, ASP.NET Core, Axum, etc.

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
openssl rand -hex 32
```

Set `JWT_SECRET` to the generated value and supply your own bootstrap email/password before starting. Missing, obvious weak, and example signing keys are rejected. If a superadministrator already exists, bootstrap credentials may be omitted; startup does not reset existing accounts.

### Configuration Reference

| Variable | Required | Default / Example | Purpose |
|---|---|---|---|
| `PORT` | Optional | `8080` | Port for the HTTP server to listen on. |
| `DATABASE_URL` | **Yes** | `postgres://airrest:airrest_secret_password@localhost:5432/airrest_db?sslmode=disable` | PostgreSQL connection string. For Vercel Serverless, use a pooled connection string with `?sslmode=require`. |
| `JWT_SECRET` | **Yes** | No default; generate with `openssl rand -hex 32` | High-entropy signing key (minimum 32 characters) for HS256 JWT tokens. |
| `JWT_EXPIRATION_HOURS` | Optional | `72` | Access token lifespan in hours. |
| `JWT_REFRESH_EXPIRATION_DAYS` | Optional | `30` | Rolling refresh token lifespan in days. |
| `SUPERADMIN_EMAIL` | First startup | User-supplied email | Email for bootstrap Superadmin account created on first launch. |
| `SUPERADMIN_PASSWORD` | First startup | User-supplied unique password (12–72 bytes) | Password for bootstrap Superadmin account. |
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
- **Cold-Start Lazy Init**: Database connections and router setup initialize on demand. Successful initialization is reused. Failed attempts retry after exponential backoff (1, 2, 4, 8, 16, then 30 seconds); requests during initialization/backoff receive `503` and `Retry-After: 1`. Attempts have a 20-second deadline.

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

- `GET /api/v1/collections?workspace_id={id}&project_id={id}&include_items={bool}` — List collections (returns lightweight metadata by default; full collection items fetched 1-by-1 via `/api/v1/collections/{id}` to prevent serverless payload limits)
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
- `DELETE /api/v1/admin/users/{userId}` — Permanently delete user account and cascade private workspaces

---

## 📦 Quick Test in AirREST / Postman

A pre-configured collection is included: `backend/airrest_api_collection.json`.
1. Open AirREST (or Postman).
2. Click **Import** and select `backend/airrest_api_collection.json`.
3. Set your environment variable `baseUrl` to `http://localhost:8080`.
4. Run `Superadmin Login` — the authentication token will be automatically saved to your active environment!


## Security upgrade and limits

- Apply `005_user_token_version.sql` before starting the updated backend when `SKIP_MIGRATIONS=true`. Automatic migrations otherwise apply it on startup. Existing sessions must sign in again after deployment.
- Password updates atomically increment `users.token_version`. Access and refresh tokens with an old or missing version return `401`; self-service password changes return replacement tokens for the current device, while administrator resets revoke every target-user session. Requests authenticated before a reset may finish.
- If old default credentials were used, rotate both the signing key and administrator password. Startup validation does not repair existing credentials.
- Requests are limited to 4 MiB, 16 concurrent handlers per instance, and 30 seconds. Oversize requests return `413`; saturation returns `503 SERVER_BUSY` with `Retry-After: 1`; expiration returns `503 REQUEST_TIMEOUT`. Proxy limits may be smaller.
- Sync push accepts at most 500 total mutations. Import accepts at most 100 collections, 5,000 total items, and 32 item levels. Limit failures return `413 BATCH_LIMIT_EXCEEDED` before any writes. The extension imports multiple selected collections as separate atomic requests and reports partial progress; split or flatten an individual oversized collection before importing it.
- Contributors may author and remove requests/folders, but cannot delete collections/environments or move collections. Moves require `collection:move` on both project scopes, ownership for private scopes, and the collection's `min_role` in each project.

### Disposable PostgreSQL regression suite

Use a new local database whose name ends in `_test`, never an application database. For example:

```bash
docker run --rm -d --name airrest-security-tests -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=airrest_audit_test -p 127.0.0.1:55432:5432 postgres:16-alpine
AIRREST_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/airrest_audit_test?sslmode=disable' go test -race -count=1 ./...
docker stop airrest-security-tests
```

The suite creates and removes a unique schema and uses a one-connection application pool. Without `AIRREST_TEST_DATABASE_URL`, integration tests explicitly skip; unit tests still run.
