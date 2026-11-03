# Specification Miner Survey Report & API Contract Audit

**Working Directory**: `/data/data/com.termux/files/home/AirREST/.agents/teamwork/teamwork_spec_miner_survey_3/`  
**Target Scope**: Backend server source code, OpenAPI specs (`openapi.yaml`, `openapi.json`), API Contract guide (`API_CONTRACT.md`), and test collection (`airrest_api_collection.json`).  
**Auditor**: Survey Agent 3 (API Contract & Backend Spec Miner)  
**Date**: 2026-11-02  

---

## 1. Observation

A complete static inspection and comparative audit was conducted across the entire `backend/` directory, including:
1. Specification and contract artifacts:
   - `backend/openapi.yaml` (3,733 lines, 110,874 bytes, OpenAPI 3.1.0)
   - `backend/openapi.json` (5,513 lines, 154,476 bytes, OpenAPI 3.1.0)
   - `backend/API_CONTRACT.md` (598 lines, 39,655 bytes)
   - `backend/airrest_api_collection.json` (1,292 lines, 37,523 bytes, Postman Collection v2.1.0)
2. Backend Go implementation (Go 1.26):
   - Entry points: `backend/cmd/server/main.go`, `backend/api/index.go` (Vercel serverless entry)
   - App setup & routing: `backend/core/app/app.go`
   - Config: `backend/config/config.go`
   - Domain models: `core/domain/*.go` (8 entity files)
   - Handlers: `core/handler/*.go` (10 handler files)
   - Middleware: `core/middleware/*.go` (5 middleware files)
   - Services: `core/service/*.go` (8 service files)
   - Repositories & Migrations: `core/repository/postgres/*.go`, `core/repository/migrations/*.sql` (8 SQL migration files)
   - Shared packages: `pkg/hasher`, `pkg/response`, `pkg/token`

### Direct Observations & File References:
1. **Routing & Endpoints**:
   - `backend/core/app/app.go:105-244` registers 59 total endpoints across public health, public auth, authenticated profile/workspaces/teams/projects/collections/items/environments/sync, and superadmin routes.
   - `openapi.yaml` and `openapi.json` specify all 59 endpoints.
   - `airrest_api_collection.json` defines only 24 requests, omitting 35 backend endpoints (59.3% coverage gap).
2. **CORS Origins**:
   - `backend/config/config.go:97`: `AllowedOrigins: []string{"http://localhost:*", "http://127.0.0.1:*", "https://*"}`
   - `backend/core/app/app.go:94-101`: Passes `cfg.AllowedOrigins` directly to `cors.Handler` with `AllowCredentials: true`.
   - `backend/API_CONTRACT.md:60-70`: Mandates `*` or dynamic origin reflection, noting browser extension sandboxes with `chrome-extension://<id>` and `null`.
   - `backend/openapi.yaml:70`: Mandates `Allowed Origins: * or user-configured hosts, including chrome-extension://*`.
3. **Optimistic Concurrency Control (OCC)**:
   - `backend/core/service/collection_service.go:271` & `501`: `UpdateCollection` and `UpdateItem` strictly pass `base_version` to the database query `WHERE id = $X AND version = $baseVersion`.
   - `backend/core/service/environment_service.go:191-193`: `if baseVersion <= 0 { baseVersion = existing.Version }`. If `base_version` is omitted or 0, OCC locking is silently bypassed and replaced with current server version, permitting unconditional overwrite.
4. **Postman Collection URL Corruption**:
   - `backend/airrest_api_collection.json:1080`: Under "Security: Sync and import" -> "Pull one scope", the path array is `["api", "v1", "sync", "pull?workspace_id={{workspaceId}}"]` instead of `"pull"`, corrupting URL resolution.
5. **Postman Collection Registration Script**:
   - `backend/airrest_api_collection.json:128-134`: Test script asserts `res.data && res.data.token`.
   - `backend/core/handler/auth_handler.go:46-48`: Registration always returns HTTP 403 Forbidden with `code: "REGISTRATION_DISABLED"`.
6. **Error Message Exposure**:
   - `backend/core/middleware/auth.go:55`: `response.Error(w, http.StatusInternalServerError, "database error during authentication: "+err.Error(), "DATABASE_ERROR")`.
   - `backend/core/handler/admin_handler.go:173`: `response.Error(w, http.StatusInternalServerError, "failed to delete user: "+err.Error(), "SERVER_ERROR")`.
7. **Database Migrations on Cold Start**:
   - `backend/core/repository/postgres/db.go:88-101`: `runMigrations` reads and executes all 8 SQL files on every pool initialization without a `schema_migrations` tracking table.
8. **Test Suite Coverage**:
   - Out of 10 HTTP handler modules, only 3 have test files (`admin_handler_test.go`, `collection_handler_test.go`, `feature_policy_handler_test.go`). 7 handlers have zero test files (`auth_handler`, `user_handler`, `workspace_handler`, `team_handler`, `project_handler`, `environment_handler`, `sync_handler`).
   - `security_integration_test.go:31` skips unless `AIRREST_TEST_DATABASE_URL` is set to a disposable PostgreSQL database ending in `_test`.

---

## 2. Logic Chain

1. **CORS Breaking Browser Extension**:
   - `cors.Options` in `app.go` matches client origin against `cfg.AllowedOrigins`.
   - Because `cfg.AllowedOrigins` only matches `http://localhost:*`, `http://127.0.0.1:*`, and `https://*`, any request from `chrome-extension://<id>` (or `null`) fails preflight origin validation.
   - When the AirREST Chrome Extension attempts to sync with the backend, the browser blocks the request due to CORS header absence.
   - This directly violates the interface specification in `API_CONTRACT.md` and `openapi.yaml`.

2. **OCC Bypass in Environment Updates**:
   - `API_CONTRACT.md § 4` specifies that mutable entities subject to OCC (`collections`, `collection_items`, `environments`) must abort writes and return HTTP 409 Conflict if `base_version != current_server_version`.
   - In `collection_service.go`, omitting `base_version` results in `baseVersion == 0`, which fails `WHERE version = 0` and produces `409 Conflict`.
   - However, in `environment_service.go:191-193`, `if baseVersion <= 0 { baseVersion = existing.Version }`. If a client sends an update without `base_version`, the server assigns `baseVersion = existing.Version` and writes the update, silently overwriting concurrent changes.

3. **Information Leakage via Unfiltered Error Strings**:
   - `auth.go:55` appends `err.Error()` to the error message returned to the client.
   - In PostgreSQL connectivity failures (e.g. timeout, DNS resolution failure, connection refused, authentication rejection), `pgx` errors often contain connection hostnames, IP addresses, database names, or query fragments.
   - Returning this directly in the response envelope leaks internal network infrastructure to unauthenticated external actors.

4. **Incomplete Postman Collection Impact**:
   - `AGENTS.md` mandates that `backend/airrest_api_collection.json` must be updated whenever backend REST endpoints, headers, or request bodies change.
   - 35 out of 59 endpoints are missing from `airrest_api_collection.json`, including the entirety of the Environments API (`/api/v1/environments/*`), Team Member management, Project Member management, and collection moves.
   - Developers and QA using the collection cannot test environments, RBAC roles, or member assignments.

5. **Serverless Migration Latency & Contention**:
   - In serverless hosting (e.g., Vercel), instances scale horizontally and spin up on demand.
   - Because `runMigrations` is executed on every database pool connection and does not record applied migrations in a migration table, multiple cold starts concurrently issue 8 DDL statements.
   - This incurs unnecessary database roundtrips and risks transaction deadlocks on PostgreSQL system catalogs.

---

## 3. Caveats

1. **Subprocess Execution Limitation**:
   - The environment shell execution failed with permission denied due to Termux container restrictions (`run_command` and `grep_search` attempted to spawn `/data/data/com.termux/files/usr/bin/bash` and `/data/data/com.termux/files/usr/bin/git`).
   - Consequently, dynamic execution of `go test` and automated OpenAPI validators (`spectral`, `swagger-cli`) was not executable via CLI.
   - All analyses were performed via direct file reading, structural JSON/YAML verification, line-by-line code tracing, and schema alignment.
2. **Database State**:
   - No active PostgreSQL database was connected during this survey turn; database schema behavior was verified by reviewing embedded migration SQL scripts (`001` through `008`).

---

## 4. Conclusion

- **Contract Synchronization**:
  - `openapi.yaml`, `openapi.json`, and `API_CONTRACT.md` are in 100% synchronization regarding endpoint paths, HTTP methods, RBAC rules, response envelopes, and OCC definitions.
  - However, `airrest_api_collection.json` suffers from significant drift: 35 endpoints are missing, the `sync/pull` path is corrupted, and the registration test script contradicts the backend's disabled public registration rule.
- **Security & Privacy Sanitization**:
  - Zero corporate mentions or private infrastructure names were found. Sample datasets, emails, and URLs strictly adhere to `AGENTS.md` guidelines (`example.com`, `httpbin.org`, `localhost`).
  - Authentication and token versioning are securely architected, but internal error messages are leaked on 500 errors in `auth.go` and `admin_handler.go`.
  - CORS configuration blocks Chrome Extension origins (`chrome-extension://*`).
- **Code Quality & Reliability**:
  - `EnvironmentService.Update` has an OCC bypass flaw where `baseVersion <= 0` resets to `existing.Version`.
  - Cold starts execute unversioned SQL migrations every time.
  - Test coverage is heavily skewed: only 3 of 10 handlers have unit tests, and integration tests skip unless an external test database is provided.

---

## 5. Verification Method

To independently verify all findings:
1. **Inspect CORS Configuration**:
   - Inspect `backend/config/config.go:97` and `backend/core/app/app.go:94-101`. Note `AllowedOrigins` does not include `chrome-extension://*`.
2. **Inspect Postman Collection Deficiencies**:
   - Inspect `backend/airrest_api_collection.json:1080` to observe the malformed path `"pull?workspace_id={{workspaceId}}"`.
   - Inspect `backend/airrest_api_collection.json:128-134` and `backend/core/handler/auth_handler.go:46-48` to observe the registration test assertion mismatch.
   - Count the `item` entries in `backend/airrest_api_collection.json` (24 items) vs routes in `backend/core/app/app.go` (59 routes).
3. **Inspect OCC Concurrency Bypass**:
   - Inspect `backend/core/service/environment_service.go:191-193` vs `backend/core/service/collection_service.go:271`.
4. **Inspect Error Message Exposure**:
   - Inspect `backend/core/middleware/auth.go:55` and `backend/core/handler/admin_handler.go:173`.
5. **Inspect Test Coverage**:
   - Search for `*_test.go` in `backend/core/handler/` — observe missing test files for `auth_handler`, `user_handler`, `workspace_handler`, `team_handler`, `project_handler`, `environment_handler`, `sync_handler`.

---

# Detailed Spec Mining & Audit Documentation

## Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Health & System | Root Ping | Basic ping returning service metadata, status, serverless mode, and timestamp | None | `{ "service": string, "status": "running", "serverless": bool, "time": ISO8601 }` | 503 if server busy | `core/app/app.go:105`, `openapi.yaml:113` |
| 2 | Health & System | Health Check | Standard health endpoint for container / orchestrator readiness | None | `{ "status": "healthy", "service": string, "serverless": bool, "time": ISO8601 }` | 503 if server busy | `core/app/app.go:114`, `openapi.yaml:131` |
| 3 | Health & System | API v1 Health | Identical healthcheck under `/api/v1/health` | None | `{ "status": "healthy", "service": string, "serverless": bool, "time": ISO8601 }` | 503 if server busy | `core/app/app.go:126`, `openapi.yaml:149` |
| 4 | Authentication | Public Registration | Disabled registration endpoint | `{ email, password, name }` | None | 403 `REGISTRATION_DISABLED` | `core/handler/auth_handler.go:46`, `openapi.yaml:167` |
| 5 | Authentication | User Login | Authenticates credentials, returns user profile, 72h JWT access token, and 30-day rolling refresh token | `{ email, password }` | `{ user, token, refresh_token, expires_at }` | 401 `INVALID_CREDENTIALS`, 400 `BAD_REQUEST` | `core/handler/auth_handler.go:51`, `openapi.yaml:205` |
| 6 | Authentication | Silent Rolling Refresh | Renews access token using valid refresh token; verifies `token_version` | `{ refresh_token }` | `{ user, token, refresh_token, expires_at }` | 401 `INVALID_REFRESH_TOKEN` | `core/handler/auth_handler.go:77`, `openapi.yaml:235` |
| 7 | Authentication | Profile Lookup (`/me`) | Retrieves authenticated caller's profile | `Authorization: Bearer <token>` | `User` object wrapped in envelope | 401 `UNAUTHORIZED` / `TOKEN_EXPIRED` | `core/handler/auth_handler.go:104`, `openapi.yaml:265` |
| 8 | Authentication | Update Profile | Updates caller display name and optional avatar URL | `{ name, avatar_url? }` | Updated `User` object | 400 `VALIDATION_ERROR`, 401 `UNAUTHORIZED` | `core/handler/auth_handler.go:125`, `openapi.yaml:291` |
| 9 | Authentication | Change Password | Validates old password, updates hash, increments `token_version`, revokes all other sessions, returns fresh token pair | `{ current_password, new_password }` | `{ user, token, refresh_token, expires_at }` | 400 `INVALID_CURRENT_PASSWORD`, 400 `VALIDATION_ERROR` | `core/handler/auth_handler.go:152`, `openapi.yaml:325` |
| 10 | User Directory | User Search | Searches users by email or name (min 2 chars, max 50 results) | Query params: `email` or `q` | `User[]` array | 500 `SERVER_ERROR` | `core/handler/user_handler.go:20`, `openapi.yaml:359` |
| 11 | Feature Controls | Get Global Policy | Reads global cloud collection capability flags | `Authorization: Bearer <token>` | `{ flags, revision, updated_by?, updated_at }` | 503 `FEATURE_POLICY_UNAVAILABLE` | `core/handler/feature_policy_handler.go:34`, `openapi.yaml:1862` |
| 12 | Feature Controls | Admin Get Policy | Superadmin view of feature policy | Superadmin Bearer token | `{ flags, revision, updated_by?, updated_at }` | 403 `FORBIDDEN` | `core/handler/feature_policy_handler.go:47`, `openapi.yaml:1890` |
| 13 | Feature Controls | Admin Update Policy | Atomically updates 3 boolean flags with OCC `base_revision` | `{ base_revision, flags: { "collection.move", "collection.delete", "collection.export" } }` | Updated `FeaturePolicy` | 400 `BAD_REQUEST`, 409 `CONFLICT` | `core/handler/feature_policy_handler.go:51`, `openapi.yaml:1914` |
| 14 | Workspaces | List Workspaces | Lists private workspaces owned by caller | Bearer token | `Workspace[]` array | 500 `SERVER_ERROR` | `core/handler/workspace_handler.go:27`, `openapi.yaml:392` |
| 15 | Workspaces | Create Workspace | Creates private workspace | `{ name, description? }` | `Workspace` object | 400 `VALIDATION_ERROR` | `core/handler/workspace_handler.go:37`, `openapi.yaml:413` |
| 16 | Workspaces | Get Workspace | Retrieves private workspace details | Path `id: UUID` | `Workspace` object | 404 `NOT_FOUND` | `core/handler/workspace_handler.go:53`, `openapi.yaml:440` |
| 17 | Workspaces | Update Workspace | Updates workspace name and description | Path `id: UUID`, `{ name, description? }` | `Workspace` object | 400 `VALIDATION_ERROR` | `core/handler/workspace_handler.go:70`, `openapi.yaml:473` |
| 18 | Workspaces | Delete Workspace | Deletes workspace (guards against deleting `is_default: true`) | Path `id: UUID` | `{ message: string }` | 400 `OPERATION_FAILED` | `core/handler/workspace_handler.go:93`, `openapi.yaml:505` |
| 19 | Teams | List Teams | Lists caller's teams (or all teams for Superadmin) | Bearer token | `Team[]` array | 500 `SERVER_ERROR` | `core/handler/team_handler.go:33`, `openapi.yaml:533` |
| 20 | Teams | Create Team | Creates organizational team (Superadmin only) | `{ name, description? }` | `Team` object | 403 `FORBIDDEN` | `core/handler/team_handler.go:43`, `openapi.yaml:554` |
| 21 | Teams | Get Team | Gets team details | Path `id: UUID` | `Team` object | 404 `NOT_FOUND` | `core/handler/team_handler.go:63`, `openapi.yaml:587` |
| 22 | Teams | Update Team | Updates team name and description (Superadmin only) | Path `id: UUID`, `{ name, description? }` | `Team` object | 403 `FORBIDDEN` | `core/handler/team_handler.go:80`, `openapi.yaml:614` |
| 23 | Teams | Delete Team | Permanently deletes team and cascades projects (Superadmin only) | Path `id: UUID` | `{ message: string }` | 403 `FORBIDDEN` | `core/handler/team_handler.go:107`, `openapi.yaml:647` |
| 24 | Teams | List Team Members | Lists members of team with user profile details | Path `id: UUID` | `TeamMember[]` array | 403 `FORBIDDEN` | `core/handler/team_handler.go:127`, `openapi.yaml:675` |
| 25 | Teams | Add/Update Team Member | Adds user to team or updates role (`admin`, `member`) | Path `id: UUID`, `{ user_id, role }` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/team_handler.go:144`, `openapi.yaml:702` |
| 26 | Teams | Remove Team Member | Removes member from team and unassigns from projects | Path `id: UUID`, Path `userId: UUID` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/team_handler.go:177`, `openapi.yaml:736` |
| 27 | Projects | List Team Projects | Lists projects in team with project isolation enforcement | Path `teamId: UUID` | `Project[]` array | 500 `SERVER_ERROR` | `core/handler/project_handler.go:33`, `openapi.yaml:771` |
| 28 | Projects | Create Project | Creates project in team (Team Admin / Superadmin) | Path `teamId: UUID`, `{ name, description? }` | `Project` object | 403 `OPERATION_FAILED` | `core/handler/project_handler.go:50`, `openapi.yaml:801` |
| 29 | Projects | Get Project | Gets project details and caller's `user_role` & computed `permissions` | Path `id: UUID` | `Project` object | 404 `NOT_FOUND` | `core/handler/project_handler.go:73`, `openapi.yaml:835` |
| 30 | Projects | Update Project | Updates project details (Project Admin / Superadmin) | Path `id: UUID`, `{ name, description? }` | `Project` object | 403 `OPERATION_FAILED` | `core/handler/project_handler.go:90`, `openapi.yaml:863` |
| 31 | Projects | Delete Project | Deletes project and its collections | Path `id: UUID` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/project_handler.go:113`, `openapi.yaml:896` |
| 32 | Projects | List Members | Lists project members with roles and computed capabilities | Path `id: UUID` | `ProjectMember[]` array | 403 `FORBIDDEN` | `core/handler/project_handler.go:129`, `openapi.yaml:924` |
| 33 | Projects | Assign Member | Assigns user to project with role (`admin`, `maintainer`, `contributor`, `reader`) | Path `id: UUID`, `{ user_id, role }` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/project_handler.go:146`, `openapi.yaml:951` |
| 34 | Projects | Unassign Member | Removes user from project | Path `id: UUID`, Path `userId: UUID` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/project_handler.go:184`, `openapi.yaml:985` |
| 35 | Collections | List Collections | Lists collections in scope; filters by `min_role`; supports `include_items=false` and gzip encoding | Query: `workspace_id` or `project_id`, `include_items` | `Collection[]` array | 403 `OPERATION_FAILED`, 413 `RESPONSE_PAYLOAD_TOO_LARGE` | `core/handler/collection_handler.go:45`, `openapi.yaml:1019` |
| 36 | Collections | Create Collection | Creates collection with initial version 1 | `{ workspace_id?, project_id?, name, description?, min_role? }` | `Collection` object | 400 `BAD_REQUEST`, 403 `OPERATION_FAILED` | `core/handler/collection_handler.go:74`, `openapi.yaml:1070` |
| 37 | Collections | Get Collection | Retrieves collection with full nested folder/request item tree | Path `id: UUID` | `Collection` object | 404 `NOT_FOUND` | `core/handler/collection_handler.go:121`, `openapi.yaml:1097` |
| 38 | Collections | Update Collection (OCC) | Updates metadata; enforces `base_version` OCC check | Path `id: UUID`, `{ name, description?, min_role?, base_version }` | `Collection` object | 400 `BAD_REQUEST`, 409 `CONFLICT` | `core/handler/collection_handler.go:139`, `openapi.yaml:1135` |
| 39 | Collections | Soft Delete Collection | Sets collection tombstone (`deleted_at`); cascades soft-delete to all child items; requires feature flag | Path `id: UUID` | `{ message: string }` | 403 `FEATURE_DISABLED`, 403 `OPERATION_FAILED` | `core/handler/collection_handler.go:180`, `openapi.yaml:1188` |
| 40 | Collections | Move Collection | Moves collection between workspaces/projects within same team; updates child items `updated_at` | Path `id: UUID`, `{ target_workspace_id?, target_project_id? }` | `{ message: string }` | 403 `FEATURE_DISABLED`, 400 `BAD_REQUEST` | `core/handler/collection_handler.go:205`, `openapi.yaml:1228` |
| 41 | Collections | Reorder Items | Batch reorders items and folder parentage within collection | Path `id: UUID`, `{ items: [{ id, parent_id, sort_order }] }` | `{ message: string, items: CollectionItem[] }` | 400 `BAD_REQUEST` | `core/handler/collection_handler.go:355`, `openapi.yaml:1269` |
| 42 | Collections | Reorder Items Alias | Contract alias route `/api/v1/collections/{id}/items/reorder` | Path `id: UUID`, payload as above | `{ message: string, items: CollectionItem[] }` | 400 `BAD_REQUEST` | `core/app/app.go:207`, `openapi.yaml:1316` |
| 43 | Collection Items | Create Item | Creates request or folder item; validates hierarchy, key-value arrays, auth config, and touches collection version | `CollectionItem` JSON | `CollectionItem` object | 400 `BAD_REQUEST`, 403 `OPERATION_FAILED` | `core/handler/collection_handler.go:257`, `openapi.yaml:1363` |
| 44 | Collection Items | Get Item | Retrieves individual folder or request item details | Path `id: UUID` | `CollectionItem` object | 404 `NOT_FOUND` | `core/handler/collection_handler.go:332`, `openapi.yaml:1405` |
| 45 | Collection Items | Update Item (OCC) | Updates item details; enforces `base_version` OCC check; touches collection version | Path `id: UUID`, `{ item: CollectionItem, base_version }` | `CollectionItem` object | 400 `BAD_REQUEST`, 409 `CONFLICT` | `core/handler/collection_handler.go:282`, `openapi.yaml:1438` |
| 46 | Collection Items | Soft Delete Item | Soft deletes item; recursively soft-deletes subtree if folder; touches collection version | Path `id: UUID` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/collection_handler.go:315`, `openapi.yaml:1492` |
| 47 | Environments | List Environments | Lists scoped environments filtered by `min_role` | Query: `workspace_id` or `project_id` | `Environment[]` array | 403 `OPERATION_FAILED` | `core/handler/environment_handler.go:40`, `openapi.yaml:1530` |
| 48 | Environments | Create Environment | Creates scoped environment with initial variables array | `{ workspace_id?, project_id?, name, variables, min_role? }` | `Environment` object | 400 `BAD_REQUEST`, 403 `OPERATION_FAILED` | `core/handler/environment_handler.go:67`, `openapi.yaml:1562` |
| 49 | Environments | Get Environment | Retrieves environment details | Path `id: UUID` | `Environment` object | 404 `NOT_FOUND` | `core/handler/environment_handler.go:114`, `openapi.yaml:1588` |
| 50 | Environments | Update Environment (OCC) | Updates environment variables and `min_role` | Path `id: UUID`, `{ name?, variables?, min_role?, base_version? }` | `Environment` object | 409 `CONFLICT`, 403 `OPERATION_FAILED` | `core/handler/environment_handler.go:132`, `openapi.yaml:1615` |
| 51 | Environments | Soft Delete Environment | Sets environment tombstone (`deleted_at != null`) | Path `id: UUID` | `{ message: string }` | 403 `OPERATION_FAILED` | `core/handler/environment_handler.go:169`, `openapi.yaml:1654` |
| 52 | Stateless Sync | Delta Pull | Pulls changes and tombstones updated after `since`; supports gzip | Query: `workspace_id` or `project_id`, `since` | `{ collections, items, environments, server_time }` | 400 `BAD_REQUEST`, 403 `FORBIDDEN` | `core/handler/sync_handler.go:31`, `openapi.yaml:1683` |
| 53 | Stateless Sync | Push Changeset | Applies up to 500 offline mutations; evaluates OCC per mutation; returns applied IDs and conflicts | `{ workspace_id?, project_id?, collections[], items[], environments[] }` | `{ applied_ids, conflicts, server_time }` | 413 `BATCH_LIMIT_EXCEEDED`, 415 `UNSUPPORTED_CONTENT_ENCODING` | `core/handler/sync_handler.go:69`, `openapi.yaml:1750` |
| 54 | Stateless Sync | Import Batch | Atomically imports offline LocalStorage collections tree (limits: 100 collections, 5000 items, 32 levels) | `{ workspace_id?, project_id?, collections: ImportCollectionRequest[] }` | `{ message: string }` | 413 `BATCH_LIMIT_EXCEEDED`, 409 `CONFLICT` | `core/handler/sync_handler.go:88`, `openapi.yaml:1803` |
| 55 | Admin Management | List All Users | Lists all registered users (Superadmin only) | Superadmin Bearer token | `User[]` array | 403 `FORBIDDEN` | `core/handler/admin_handler.go:42`, `openapi.yaml:1956` |
| 56 | Admin Management | Provision User | Creates account with assigned system role (`superadmin` or `user`) | `{ email, password, name, role }` | `User` object | 409 `EMAIL_EXISTS`, 400 `VALIDATION_ERROR` | `core/handler/admin_handler.go:53`, `openapi.yaml:1983` |
| 57 | Admin Management | Update User | Updates user display name and avatar (Superadmin only) | Path `userId: UUID`, `{ name, avatar_url? }` | `User` object | 404 `NOT_FOUND`, 400 `VALIDATION_ERROR` | `core/handler/admin_handler.go:114`, `openapi.yaml:2051` |
| 58 | Admin Management | Reset User Password | Resets target user's password and revokes all their sessions | Path `userId: UUID`, `{ password }` | `{ message: string }` | 404 `NOT_FOUND`, 400 `VALIDATION_ERROR` | `core/handler/admin_handler.go:83`, `openapi.yaml:2016` |
| 59 | Admin Management | Delete User | Permanently deletes account, cascades workspaces, and reassigns created teams/projects to caller | Path `userId: UUID` | `{ message: string }` | 400 `BAD_REQUEST` (cannot delete self / last admin) | `core/handler/admin_handler.go:146`, `openapi.yaml:2103` |

---

## Edge Cases

| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | Global Limits | Request body > 4 MiB (4,194,304 bytes) | HTTP 413 Payload Too Large (`PAYLOAD_TOO_LARGE`). |
| 2 | Global Concurrency | More than 16 concurrent requests running | HTTP 503 Service Unavailable (`SERVER_BUSY`) with header `Retry-After: 1`. |
| 3 | Request Timeout | Handler execution exceeds 300 seconds | HTTP 503 Service Unavailable (`REQUEST_TIMEOUT`). |
| 4 | Sync Gzip Request | Compressed body > 3,000,000 bytes or decompressed > 16 MiB | HTTP 413 Payload Too Large (`PAYLOAD_TOO_LARGE`). |
| 5 | Sync Request Body | Multiple JSON documents or trailing non-whitespace data | HTTP 400 Bad Request (`BAD_REQUEST`) via `RequireSingleJSONDocument`. |
| 6 | Sync Response Compression | Client sends `Accept-Encoding: identity;q=0, gzip;q=0` | HTTP 406 Not Acceptable (`NOT_ACCEPTABLE`). |
| 7 | Response Size Budget | Response exceeds 4 MiB uncompressed or 3,000,000 bytes compressed | HTTP 413 Payload Too Large (`RESPONSE_PAYLOAD_TOO_LARGE`). |
| 8 | OCC Version Match | `PUT /collections/{id}` with `base_version == db_version` | Writes update, increments version by 1, updates `updated_at`, returns HTTP 200 OK. |
| 9 | OCC Version Mismatch | `PUT /collections/{id}` with `base_version != db_version` | Aborts write, returns HTTP 409 Conflict with remote entity in `"data"` envelope. |
| 10 | OCC Zero Base Version (Collections) | `PUT /collections/{id}` with `base_version: 0` | Fails OCC check (`WHERE version = 0`), returns HTTP 409 Conflict. |
| 11 | OCC Zero Base Version (Environments) | `PUT /environments/{id}` with `base_version: 0` | **Anomaly**: Replaces `baseVersion` with `existing.Version`, bypassing OCC and silently updating remote data. |
| 12 | Password Change Revocation | Valid password change via `PUT /api/v1/auth/password` | Increments `token_version` in DB; old access tokens fail with 401 `SESSION_REVOKED`; old refresh tokens fail with 401 `INVALID_REFRESH_TOKEN`. Current device receives replacement pair. |
| 13 | Admin Password Reset Revocation | Superadmin resets another user's password | Target user's `token_version` incremented; all active tokens for target user revoked. If superadmin resets themselves, their own tokens are revoked. |
| 14 | Project Isolation | User queries `GET /api/v1/teams/{teamId}/projects` | Unassigned projects are filtered out; only projects with an explicit row in `project_members` are returned (superadmin and team admin see all projects). |
| 15 | Scope Move Direction | Move collection from project to personal workspace | Blocked with `ErrProjectCollectionMoveToPersonalScope`; even Superadmin cannot bypass this rule. |
| 16 | Scope Move Team Boundary | Move collection between projects in different teams | Blocked with `"collections can only be moved between projects within the same team"`. |
| 17 | Folder Subtree Soft-Delete | Delete a folder item (`type === 'folder'`) | Recursively soft-deletes all descendant items and subfolders within the collection in a single transaction; increments parent collection version. |
| 18 | Workspace Default Protection | Call `DELETE /api/v1/workspaces/{id}` on default workspace | Fails with `"cannot delete default workspace"`. |
| 19 | Superadmin Self-Deletion | Superadmin calls `DELETE /api/v1/admin/users/{selfId}` | Rejected with HTTP 400 Bad Request (`ErrCannotDeleteSelf`). |
| 20 | Last Superadmin Deletion | Delete the only remaining superadmin account | Rejected with HTTP 400 Bad Request (`ErrCannotDeleteLastAdmin`). |

---

# Categorized Audit Findings

```
================================================================================
PRIORITY 1 (HIGH) FINDINGS
================================================================================
```

### [P1-01] CORS Origin Filter Blocks Chrome Extension Sandboxes
- **Category**: Security / API Contract & Connectivity
- **Severity**: P1 (High)
- **Location**: `backend/config/config.go:97`, `backend/core/app/app.go:94-101`
- **Root Cause**:
  `config.go` hardcodes `AllowedOrigins` as:
  ```go
  AllowedOrigins: []string{"http://localhost:*", "http://127.0.0.1:*", "https://*"}
  ```
  `cors.Handler` in `go-chi/cors` performs prefix/pattern matching. Because Chrome extension sandboxes communicate using the `chrome-extension://<id>` origin scheme (or `null` in sandboxed frames), and `AllowCredentials: true` is configured, browser requests from the Chrome Extension are rejected during CORS preflight OPTIONS requests without the required `Access-Control-Allow-Origin` header.
- **Contract Impact**:
  Directly violates `backend/API_CONTRACT.md:60-70` ("*The Chrome Extension runs within browser sandboxes (with origins like `chrome-extension://<extension-id>` or `null`)... Allowed Origins: `*` or dynamically reflect the request `Origin` header*") and `backend/openapi.yaml:68-75`.
- **Remediation Plan**:
  Update `cors.Options` in `app.go` or `config.go` to support extension origins. Because `AllowCredentials: true` is used, the CORS handler must either:
  1. Use `AllowOriginFunc: func(r *http.Request, origin string) bool` to dynamically validate and reflect origins matching `http://localhost:*`, `http://127.0.0.1:*`, `https://*`, `chrome-extension://*`, and `null`.
  2. Include `chrome-extension://*` in `AllowedOrigins` if supported by the CORS matcher.
- **Verification Guide**:
  1. Test preflight request with `curl -I -X OPTIONS http://localhost:8080/api/v1/health -H "Origin: chrome-extension://abcdefghijklmnop" -H "Access-Control-Request-Method: GET"`.
  2. Assert response contains `Access-Control-Allow-Origin: chrome-extension://abcdefghijklmnop` and `Access-Control-Allow-Credentials: true`.

---

### [P1-02] Postman Test Collection Contains 59.3% Endpoint Coverage Gap and Corrupted Sync Pull URL
- **Category**: API Contract Synchronization & QA
- **Severity**: P1 (High)
- **Location**: `backend/airrest_api_collection.json:1078-1081`, `airrest_api_collection.json:128-134`
- **Root Cause**:
  1. Only 24 requests are configured in the Postman collection, while the backend exposes 59 active endpoints. The entirety of the Environments API (`GET/POST/PUT/DELETE /api/v1/environments/*`), Workspace item operations, Team Member operations, Project Member operations, and Collection moves are missing.
  2. In `airrest_api_collection.json:1080` (Security: Sync and import -> Pull one scope), the path array contains:
     ```json
     "path": [
       "api",
       "v1",
       "sync",
       "pull?workspace_id={{workspaceId}}"
     ]
     ```
     The query parameter is concatenated directly onto the path element, breaking URL resolution in Postman.
  3. The "Register New User" request script expects a token (`res.data.token`), but the backend endpoint permanently returns 403 `REGISTRATION_DISABLED`.
- **Contract Impact**:
  Violates `AGENTS.md` requirement: "*Whenever there are modifications, additions, or deprecations to backend REST endpoints... You MUST update backend/airrest_api_collection.json*". Automated QA runs fail or leave 35 endpoints completely unverified.
- **Remediation Plan**:
  1. Correct `airrest_api_collection.json:1080` to `"path": ["api", "v1", "sync", "pull"]` with query param `workspace_id: "{{workspaceId}}"`.
  2. Update the "Register New User" test assertion to expect HTTP 403 Forbidden with `code: "REGISTRATION_DISABLED"`.
  3. Expand `airrest_api_collection.json` to include all 35 missing endpoints:
     - Environments: List, Create, Get, Update (OCC), Soft Delete
     - Workspaces: Get, Update, Delete
     - Teams: Get, Update, Delete, List Members, Add Member, Remove Member
     - Projects: Get, Update, Delete, List Members, Add Member, Remove Member
     - Collections: Create Collection, Move Collection, Get Item, Reorder Items Alias (`/items/reorder`)
- **Verification Guide**:
  1. Validate JSON syntax with `jq . backend/airrest_api_collection.json`.
  2. Import into Postman / Newman and verify execution against the backend.

---

```
================================================================================
PRIORITY 2 (MEDIUM) FINDINGS
================================================================================
```

### [P2-01] Environment Update Silently Bypasses OCC Check When `base_version` Is Omitted or Zero
- **Category**: Data Integrity / Concurrency
- **Severity**: P2 (Medium)
- **Location**: `backend/core/service/environment_service.go:191-193`, `backend/openapi.yaml:3638-3642`
- **Root Cause**:
  In `environment_service.go:191-193`:
  ```go
  if baseVersion <= 0 {
      baseVersion = existing.Version
  }
  ```
  If a client updates an environment without providing `base_version` (or sends `0`), the service silently sets `baseVersion` to the current database version, allowing the write to succeed without conflict checking.
  In contrast, `CollectionService` strictly enforces `base_version` and fails with `409 Conflict` if `base_version <= 0`.
  Furthermore, `openapi.yaml` and `openapi.json` mark `base_version` as optional in `UpdateEnvironmentRequest`, whereas `UpdateCollectionRequest` marks it as required.
- **Impact**:
  Concurrent clients editing an environment without passing `base_version` will overwrite each other's changes rather than receiving a `409 Conflict`.
- **Remediation Plan**:
  1. Remove `if baseVersion <= 0 { baseVersion = existing.Version }` from `environment_service.go:191`. Require `baseVersion > 0`, or return `ErrVersionConflict` if missing.
  2. Update `UpdateEnvironmentRequest` in `openapi.yaml`, `openapi.json`, and `API_CONTRACT.md` to require `base_version: int64`.
- **Verification Guide**:
  1. Send `PUT /api/v1/environments/{id}` with `{ "name": "Test" }` (omitting `base_version`).
  2. Verify response is HTTP 400 Bad Request or HTTP 409 Conflict rather than silently succeeding.

---

### [P2-02] PostgreSQL Error Strings Exposed to External Clients in HTTP 500 Responses
- **Category**: Security / Information Disclosure
- **Severity**: P2 (Medium)
- **Location**: `backend/core/middleware/auth.go:55`, `backend/core/handler/admin_handler.go:173`
- **Root Cause**:
  1. `core/middleware/auth.go:55`:
     ```go
     response.Error(w, http.StatusInternalServerError, "database error during authentication: "+err.Error(), "DATABASE_ERROR")
     ```
  2. `core/handler/admin_handler.go:173`:
     ```go
     response.Error(w, http.StatusInternalServerError, "failed to delete user: "+err.Error(), "SERVER_ERROR")
     ```
- **Impact**:
  Raw PostgreSQL database driver errors (which may include database hostnames, IP addresses, schema names, or constraint names) are leaked directly to HTTP clients in production error responses.
- **Remediation Plan**:
  1. Log the internal database error via `slog.Error("authentication database error", "error", err)`.
  2. Return a sanitized, opaque error message to the client: `response.Error(w, http.StatusInternalServerError, "internal database error during authentication", "DATABASE_ERROR")`.
  3. Apply the same pattern to `admin_handler.go:173`.
- **Verification Guide**:
  1. Trigger a database disconnection or timeout during auth middleware verification.
  2. Verify response JSON contains `"error": "internal database error during authentication"` and does not expose connection strings or driver stack traces.

---

### [P2-03] Re-execution of All SQL Migrations on Every Cold Start Without Migration Tracking
- **Category**: Performance / Scalability & Reliability
- **Severity**: P2 (Medium)
- **Location**: `backend/core/repository/postgres/db.go:78-105`
- **Root Cause**:
  `runMigrations` iterates over all 8 migration SQL files and runs `pool.Exec(ctx, string(content))` every time a connection pool is initialized. There is no `schema_migrations` tracking table.
- **Impact**:
  In serverless deployments (Vercel) where new container instances spin up on demand:
  1. Cold start response time is increased by 8 sequential database round trips.
  2. Concurrent cold starts execute DDL (`ALTER TABLE`, `CREATE TABLE IF NOT EXISTS`) simultaneously, risking lock contention and PostgreSQL catalog deadlocks (`tuple concurrently updated`).
- **Remediation Plan**:
  1. Create a lightweight `schema_migrations (version VARCHAR PRIMARY KEY, applied_at TIMESTAMPTZ)` table on startup.
  2. Query applied migrations and only execute unapplied scripts.
  3. Wrap each unapplied migration in a single transaction that records the applied version.
- **Verification Guide**:
  1. Verify cold-start duration decreases when migrations are already applied.
  2. Verify no DDL statements are executed against PostgreSQL when all migrations are recorded.

---

```
================================================================================
PRIORITY 3 (LOW) FINDINGS
================================================================================
```

### [P3-01] Significant Unit Test Gaps Across Backend HTTP Handlers and Services
- **Category**: Code Quality & Test Coverage
- **Severity**: P3 (Low)
- **Location**: `backend/core/handler/`, `backend/core/service/`
- **Root Cause**:
  7 out of 10 handlers (`auth_handler`, `user_handler`, `workspace_handler`, `team_handler`, `project_handler`, `environment_handler`, `sync_handler`) have no dedicated `*_test.go` unit test suites.
  Existing tests in `security_integration_test.go` require a live PostgreSQL database and skip execution during standard offline unit test runs (`go test ./...`).
- **Impact**:
  Payload validation, route parameter parsing, and status code regressions may not be caught in standard CI environments.
- **Remediation Plan**:
  Add table-driven unit tests with mock services / mock repositories for all handlers, verifying status codes, envelope schemas, and OCC 409 conflict handling.
- **Verification Guide**:
  1. Run `go test -v ./core/handler/...` and verify 100% handler test execution without external database dependencies.

---

# Verification Guide Matrix

| Finding ID | Title | Severity | Target File(s) | Expected Verification Command / Assertion |
|---|---|:---:|---|---|
| **P1-01** | CORS Blocks Extension Origins | P1 | `config/config.go:97`, `core/app/app.go:94` | `curl -I -X OPTIONS http://localhost:8080/api/v1/health -H "Origin: chrome-extension://test"`; Assert `Access-Control-Allow-Origin: chrome-extension://test` |
| **P1-02** | Postman Collection Deficiencies | P1 | `airrest_api_collection.json:1080` | Check `jq '.item[].item[].name' airrest_api_collection.json` has 59 endpoints; verify sync pull path has no query params in path array |
| **P2-01** | OCC Bypass in Environment Update | P2 | `core/service/environment_service.go:191` | `PUT /api/v1/environments/{id}` without `base_version`; assert HTTP 400 or 409 returned |
| **P2-02** | Error Exposure in Auth Middleware | P2 | `core/middleware/auth.go:55`, `core/handler/admin_handler.go:173` | Trigger DB error during auth; verify response does not leak postgres driver strings |
| **P2-03** | Unversioned Cold Start Migrations | P2 | `core/repository/postgres/db.go:78` | Start server twice; check logs show migrations skipped on second startup |
| **P3-01** | Missing Handler Unit Tests | P3 | `core/handler/*_test.go` | Run `go test -v ./core/handler/...`; verify all 10 handlers pass unit tests |

---
*End of Report.*
