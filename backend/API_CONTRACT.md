# AirREST Backend API Contract & Re-Implementation Guide

> **Formal Specification & Interoperability Contract** for implementing a fully compatible AirREST Cloud Backend in any programming language or framework (Go, Node.js/TypeScript, Python, Java, C#, Rust, PHP, etc.).

---

## 🎯 Purpose & Scope

This specification defines the complete contract required for a backend service to integrate seamlessly with:
1. **AirREST Chrome Extension** (Manifest V3 DevTools & Popup REST client)
2. **AirREST Hub** (Team & Workspace web administration portal)

If you reimplement this backend in another tech stack (e.g., Python/FastAPI, TypeScript/NestJS, Java/Spring Boot, C#/ASP.NET Core, Rust/Axum, PHP/Laravel), **as long as your service satisfies this contract, both the Chrome Extension and Hub will work with zero code changes.**

### Available Contract Files

| File | Format | Description |
|---|---|---|
| [openapi.yaml](openapi.yaml) | YAML (OpenAPI 3.1.0) | Standard machine-readable OpenAPI 3.1.0 specification. |
| [openapi.json](openapi.json) | JSON (OpenAPI 3.1.0) | JSON equivalent for tools, linters, and code generators. |
| [airrest_api_collection.json](airrest_api_collection.json) | Postman v2.1 | Pre-configured request collection for testing and QA. |

---

## 🏛️ Core Architectural Protocols

### 1. Unified Response Envelope
Every response from the backend (both success and error) MUST follow the Envelope structure.

#### Success Response (HTTP 200 / 201)
```json
{
  "success": true,
  "data": { ... }
}
```
*Note: In the client codebase (`cloudApi.ts`), `unwrapData(json)` specifically checks for `json.data`. Always nest your payload inside `"data"`.*

#### Error Response (HTTP 400, 401, 403, 404, 500)
```json
{
  "success": false,
  "error": "Descriptive human-readable error message",
  "code": "ERROR_CODE_STRING"
}
```

#### Optimistic Concurrency Conflict (HTTP 409 Conflict)
```json
{
  "success": false,
  "error": "conflict: item has been modified by another user",
  "code": "CONFLICT",
  "data": { ...latest_server_version_of_entity... }
}
```

---

### 2. Mandatory CORS Configuration
The Chrome Extension runs within browser sandboxes (with origins like `chrome-extension://<extension-id>` or `null`), while AirREST Hub runs as a Web SPA.

Your server **must** implement CORS with the following settings:
- **Allowed Origins**: `*` or dynamically reflect the request `Origin` header.
- **Allowed Methods**: `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- **Allowed Headers**: `Accept, Authorization, Content-Type, Content-Encoding, X-CSRF-Token`
- **Exposed Headers**: `Link`
- **Allow Credentials**: `true`
- **Preflight Max Age**: `300` seconds (5 minutes)

---

### 3. Authentication & Silent Rolling Refresh

1. **Bearer JWT Token**:
   - Headers: `Authorization: Bearer <access_token>`
   - Algorithm: `HS256`
   - Payload claims must include:
     - `user_id`: User UUID
     - `email`: User email string
     - `role`: System role (`superadmin` or `user`)
     - `token_type`: `access` for access JWTs, `refresh` for refresh JWTs
     - `token_version`: Nonnegative int64 matching the user database record; missing claims are invalid
     - `iss`: `airrest-api`
     - `iat`: Issued-at timestamp (included in issued tokens)
     - `exp`: Required Unix expiration timestamp (access default: 72 hours)

2. **Rolling Refresh Token**:
   - Returned upon login / refresh as `refresh_token`: an HS256 JWT with `token_type: refresh`, issuer `airrest-api`, user identity, session version, and a 30-day expiration.
   - Refresh tokens are not stored in the database and are not single-use. Renewal issues a new token pair without invalidating the previous refresh JWT.

3. **Silent Refresh Protocol**:
   - When the client encounters an HTTP `401 Unauthorized` response on any authenticated call, it immediately invokes:
     ```http
     POST /api/v1/auth/refresh
     Content-Type: application/json

     {
       "refresh_token": "..."
     }
     ```
   - If valid, the server returns a new access token and a renewed rolling refresh token:
     ```json
     {
       "success": true,
       "data": {
         "user": { ... },
         "token": "new-access-token",
         "refresh_token": "new-rolling-refresh-token",
         "expires_at": "2026-10-25T09:00:00Z"
       }
     }
     ```
   - The client then automatically retries the initial failed request with the new token. Rejected refresh (401/403) or a rejected retry clears tokens and returns to sign-in. Temporary network/5xx failures do not sign users out.

4. **Account-wide session revocation**:
   - Add `users.token_version BIGINT NOT NULL DEFAULT 0`; keep this internal field out of user response JSON.
   - Include the current version in every issued access/refresh JWT. Authentication already loads the user and compares the version; refresh performs the same check before renewal.
   - Both self-service changes and administrator resets update the password and increment `token_version` atomically. Old access tokens return `401 SESSION_REVOKED`; old refresh tokens return `401 INVALID_REFRESH_TOKEN`. Missing-version access JWTs return `401 TOKEN_EXPIRED` under the existing invalid-token envelope.
   - Use the version from the same user snapshot whose password/token was validated. Never reread a newer version to stamp tokens authenticated using old credentials. Self-service password writes compare the validated version to prevent overwriting a concurrent reset (`400 INVALID_CURRENT_PASSWORD`).
   - A successful self-service password change returns a replacement access/refresh pair for the current device. The frontend atomically replaces its stored tokens. Every previously issued pair, including pairs on other devices, is revoked. Administrator resets do not issue a pair and revoke every target-device session. Profile edits do not revoke sessions. Requests authenticated before a reset may finish.
   - Legacy sessions require login after deployment. Apply migration `005_user_token_version.sql` explicitly if automatic migrations are disabled. Individual-device logout and refresh replay detection are not provided by account-wide versioning.

---

### 4. Optimistic Concurrency Control (OCC)

Data collisions are resolved using an explicit monotonic `version` counter (int64):
1. Entities subject to OCC: `collections`, `collection_items`, `environments`.
2. When creating an entity, initial `version` is set to `1`.
3. When updating via `PUT /api/v1/collections/{id}`, `PUT /api/v1/items/{id}`, or `PUT /api/v1/environments/{id}`, the client provides:
   ```json
   {
     "base_version": 1,
     ...fields to update...
   }
   ```
4. **Server Check**:
   - If current DB version == `base_version`:
     - Apply update.
     - Increment version to `version + 1`.
     - Update `updated_at = NOW()`.
     - Return HTTP `200 OK` with the updated object.
   - If current DB version != `base_version`:
     - Abort write.
     - Return HTTP `409 Conflict` with `code: "CONFLICT"` and `"data"` containing the current DB entity.
4. **Item-Collection Atomic Versioning**:
   - Creating, updating, or soft-deleting a `CollectionItem` (`POST /api/v1/items`, `PUT /api/v1/items/{id}`, `DELETE /api/v1/items/{id}`) and batch reordering atomically increments `collection.version` (`version = version + 1`) and updates `collection.updated_at = NOW()` in the parent collection.
   - This invalidates frontend smart caches (`useApiStore.ts`) so subsequent pulls fetch the refreshed item details.

---

### 5. Tombstone Soft-Deletes & Subtree Cascading

When a user deletes a collection, folder, item, or environment:
1. **Never physically remove the row immediately (`DELETE FROM ...`)**.
2. Instead, set `deleted_at = NOW()` and `updated_at = NOW()`.
3. **Recursive Folder Subtree Soft-Delete**:
   - Soft-deleting a folder (`type === 'folder'`) recursively soft-deletes all descendant items and subfolders within that collection atomically in a single transaction.
   - Descendant items receive individual tombstones (`deleted_at = NOW()`, `version = version + 1`), ensuring offline delta pulls purge them cleanly.
4. **Collection Deletion Atomicity**:
   - Soft-deleting a collection atomically soft-deletes all contained items in the same database transaction.
   - Deleted collections cannot receive new items, accept updates, or serve items via active REST endpoints.
5. When clients call `GET /api/v1/sync/pull?since=<timestamp>`:
   - The server queries `WHERE updated_at > $since` (including soft-deleted rows where `deleted_at IS NOT NULL`).
   - The client inspects `deleted_at`: if non-null, the client purges the item from its local IndexedDB / LocalStorage cache.
   - When a collection is moved to a new workspace or project, all contained active items have their `updated_at` updated to ensure the target scope's incremental delta pull retrieves them.
   - This ensures deleted items never reappear when another offline device reconnects.

---

### 6. Hierarchical RBAC & Project Isolation Matrix

#### System Roles
- **`superadmin`**: Unrestricted access across all teams, projects, workspaces, and administrative routes. Can provision new users and reset passwords.
- **`user`**: Standard authenticated account.

#### Team Roles
- **`admin`** (Team Admin): Can create projects in the team, manage team members, and delete projects.
- **`member`**: Can view team projects they are explicitly assigned to.

#### Project Roles (Hierarchical)
Hierarchy: `admin` > `maintainer` > `contributor` > `reader`

| Action | Admin | Maintainer | Contributor | Reader |
|---|:---:|:---:|:---:|:---:|
| Manage Project Settings & Delete Project | ✅ | ❌ | ❌ | ❌ |
| Assign / Remove Project Members | ✅ | ❌ | ❌ | ❌ |
| Create / Edit Resources (`min_role: admin`) | ✅ | ❌ | ❌ | ❌ |
| Create / Edit Resources (`min_role: maintainer`) | ✅ | ✅ | ❌ | ❌ |
| Create / Edit Resources (`min_role: contributor`) | ✅ | ✅ | ✅ | ❌ |
| View / Execute Resources (`min_role: reader`) | ✅ | ✅ | ✅ | ✅ |
| Delete Collection / Environment Containers | ✅ | ✅ | ❌ | ❌ |
| Move Collections | ✅ | ✅ | ❌ | ❌ |

Every operation also requires scope access and the resource’s `min_role`. Moves require `collection:move` and `min_role` access in both project scopes; private scopes require ownership. Project-to-project moves remain within the same team. Superadministrators retain their universal bypass and have immutable root privileges: their roles cannot be modified, downgraded, or removed from teams and projects. Request/folder deletion uses `collection:write`, so contributors may remove items in accessible collections; it does not grant container deletion.

#### Granular Capability-Based Permissions (`permissions: string[]`)
Starting in API v1.1.2+, `Project` and `ProjectMember` objects include a computed `permissions` string array. This decouples client capability checks from hardcoded integer rank comparisons while remaining 100% backward-compatible with database schemas and older client caches.

| Role | Computed Capabilities (`permissions`) | Description |
|---|---|---|
| **`admin`** | `["*"]` | Wildcard grant: unrestricted access to all collection and environment operations within the project. |
| **`maintainer`** | `["collection:read", "collection:write", "collection:delete", "collection:move", "env:read", "env:write", "env:delete"]` | Full operational control over collections, requests, folders, and environments including deletion and moving. |
| **`contributor`** | `["collection:read", "collection:write", "env:read", "env:write"]` | Standard authoring capabilities: create and edit collections/requests/environments, but cannot delete or move containers. |
| **`reader`** | `["collection:read", "env:read"]` | Read-only access: view requests and environments, execute API calls, but all save/mutation operations are blocked. |

##### Client Evaluation Protocol & Backward Compatibility Fallback
1. **Offline & Workspace Modes**: Offline workspaces and personal cloud workspaces always evaluate all capability checks as `true`.
2. **Superadmin Universal Bypass**: Authenticated superadmins always evaluate all permissions as `true`.
3. **Array Evaluation**: If `scope.permissions` is populated, access is granted if `scope.permissions.includes('*') || scope.permissions.includes(requiredPermission)`.
4. **Fallback Mechanism**: If `scope.permissions` is absent (e.g. from a stale cached scope or offline store), the client seamlessly computes capabilities from `DEFAULT_ROLE_PERMISSIONS[scope.role || 'reader']`.

#### Strict Project Isolation
- When a user calls `GET /api/v1/teams/{teamId}/projects`:
  - Superadmin sees all projects.
  - Team Admin sees all projects in their team.
  - Standard users **only receive projects where they have an active row in `project_members`**.
  - Unassigned projects are completely invisible.

---

### 7. Explicit Frontend Data Contracts & Value Expectations

#### ⚠️ Common Misconceptions: Status vs. Message vs. Error

| Field | Data Type | Expected Values | Where Used & How Handled by Frontend |
|---|---|---|---|
| **HTTP Status Code** | `number` | `200`, `201`, `400`, `401`, `403`, `404`, `409`, `500` | Frontend checks `res.ok` (`status >= 200 && status < 300`). Status `401` triggers silent token refresh; `409` triggers OCC conflict resolution. |
| **`success`** | **`boolean`** | **`true`** or **`false`** *(NOT string `"success"` / `"failed"`!)* | Indicates top-level envelope result. Every valid API response sets `success: true` on success and `success: false` on error. |
| **`message`** | **`string`** | Descriptive English sentence (e.g., `"workspace deleted successfully"`) | Used only for informational confirmations in action endpoints (delete, move, import). **FE does not check `if (message === 'success')`**. If present on error (`json.message`), FE displays it as an alert/toast. |
| **`error`** | **`string`** | Human-readable error description (e.g., `"invalid email or password"`) | Extracted by FE helper `extractError(json)`: checks `json.error`, then `json.error.message`, then `json.message`, fallback to generic text. |
| **`code`** | **`string`** | Machine-readable uppercase string (e.g., `"CONFLICT"`, `"INVALID_CREDENTIALS"`) | Identifies error category programmatically. |
| **`data`** | `object \| array` | Entity payload or conflict data | Extracted by FE helper `unwrapData(json)`: if `'data' in json`, returns `json.data`; otherwise returns `json`. On `409 Conflict`, `data` contains the current remote entity. |

#### 🏷️ Strict Enumerations Expected by Frontend

The Frontend UI, store reducers, and routing logic explicitly switch on the following enum values:

| Field Name | Context | Expected Enum Values | Frontend Usage |
|---|---|---|---|
| **`role`** | System User (`User`) | `'superadmin'`, `'user'` | `user.role === 'superadmin'` unlocks the Superadmin navigation menu, user provisioning table, and global team administration in AirREST Hub. |
| **`user_role`** | Team Member (`Team`, `TeamMember`) | `'admin'`, `'member'` | `team.user_role === 'admin'` unlocks team settings, member invite modal, and project creation. |
| **`user_role` / `min_role`** | Project & Collection (`Project`, `Collection`, `Environment`) | `'admin'`, `'maintainer'`, `'contributor'`, `'reader'` | Evaluated hierarchically (`admin > maintainer > contributor > reader`). Restricts viewing, executing, editing, and moving collections/environments. |
| **`type`** | Collection Item (`CollectionItem`) | `'folder'`, `'request'` | Controls sidebar tree rendering (directory folder with toggle chevron vs. clickable HTTP request tab). |
| **`method`** | HTTP Method (`CollectionItem`, `ApiRequest`) | `'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'`, `'HEAD'`, `'OPTIONS'` | Displayed as colored method pill badges in the UI. |
| **`body_type`** | Request Body Type | `'none'`, `'json'`, `'xml'`, `'raw'`, `'x-www-form-urlencoded'`, `'form-data'`, `'binary'`, `'graphql'` | Switches active editor panel in Request Editor tab. |
| **`raw_type`** | Raw Body Subtype | `'text'`, `'json'`, `'xml'`, `'html'` | Configures Monaco syntax highlighting mode for raw payload editor. |
| **`auth.type`** | Auth Configuration | `'none'`, `'bearer'`, `'basic'`, `'apikey'` | Switches authentication configuration form fields. |
| **`token_version`** | Access and refresh JWTs (internal) | Nonnegative integer (int64), required | Compared to `users.token_version`; never exposed in User JSON. |
| **`action`** | Sync Push Changeset (`SyncPushRequest`) | `'create'`, `'update'`, `'delete'` | Informs backend whether to insert, update with OCC, or set tombstone. |
| **`type`** | Sync Conflict (`SyncConflictReport`) | `'collection'`, `'item'`, `'environment'` | Maps conflict report to corresponding entity table for user resolution. |
| **`version` / `base_version`** | Concurrency Counter | `integer` (int64 >= 1) | Monotonically increasing number used for Optimistic Locking. |
| **`deleted_at`** | Tombstone Marker | `string` (ISO 8601) or `null` | Non-null indicates soft-deleted entity; FE immediately purges it from local storage. |

#### 🧩 Boolean & Structural Field Checks

In addition to enums, the Frontend relies on specific primitive types and relational values:

| Field Name | Context | Expected Type & Value | Frontend Logic & Behavior |
|---|---|---|---|
| **`is_default`** | `Workspace` | `boolean` (`true` \| `false`) | Frontend checks `if (workspace.is_default)`. If `true`, the UI disables the "Delete Workspace" button and guards against accidental deletion of the primary workspace. |
| **`enabled`** | `KeyValuePair`, `EnvironmentVariable` | `boolean` (`true` \| `false`) | During request dispatch (`fetcher.ts`), FE filters `items.filter(item => item.enabled)`. Disabled params, headers, and environment variables are excluded from the HTTP request. |
| **`parent_id`** | `CollectionItem` | `string` (UUID) or `null` | Used by `buildItemTree()` in `cloudSyncTransformer.ts`. Items with `parent_id === null` (or omitted) are rendered as root items in the collection. Items with a folder UUID are nested inside that folder. |
| **`sort_order`** | `CollectionItem`, `ReorderItemPosition` | `integer` (>= 0) | Frontend tree rendering sorts items ascending: `.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))`. |
| **`token` & `refresh_token`** | Auth response | Non-empty `string` | Frontend checks `if (data.token && data.refresh_token)`. If either is missing, the login/refresh callback is rejected and user session is cleared. |
| **`collections` & `items` & `environments`** | Sync Delta (`GET /api/v1/sync/pull`) | `Array` (must not be `null`) | Frontend does `for (const bc of delta.collections || [])` and `for (const item of delta.items || [])`. Return empty array `[]` instead of `null` if no records exist. |

---

## 📡 Complete REST Endpoints Specification

### 1. Health & System
- `GET /` — Root metadata ping: `{ "service": "AirREST Cloud API", "status": "running", "serverless": bool, "time": "..." }`
- `GET /health` — Service healthcheck: `{ "status": "healthy", "service": "AirREST Cloud API", "serverless": bool, "time": "..." }`
- `GET /api/v1/health` — API v1 healthcheck: identical envelope as `/health`.

### 2. Authentication & Profile
- `POST /api/v1/auth/register` — Register a new account.
  - Payload: `{ "email": string, "password": string, "name": string }`
  - Note: Can return 403 Forbidden with `code: "REGISTRATION_DISABLED"` if self-registration is closed.
- `POST /api/v1/auth/login` — Log in with email and password.
  - Payload: `{ "email": string, "password": string }`
  - Response: `{ "user": User, "token": string, "refresh_token": string, "expires_at": string }`
- `POST /api/v1/auth/refresh` — Renew access token.
  - Payload: `{ "refresh_token": string }`
  - Response: `{ "user": User, "token": string, "refresh_token": string, "expires_at": string }`
- `GET /api/v1/auth/me` *(Auth)* — Return current user profile.
- `PUT /api/v1/auth/profile` *(Auth)* — Update current user's name and avatar URL.
  - Payload: `{ "name": string, "avatar_url"?: string }`
- `PUT /api/v1/auth/password` *(Auth)* — Change password with current password verification.
  - Payload: `{ "current_password": string, "new_password": string }`
  - Response: `{ "user": User, "token": string, "refresh_token": string, "expires_at": string }`; replace the current device tokens with this pair. Existing tokens are revoked.

### 3. User Directory
- `GET /api/v1/users/search?email=...` or `?q=...` *(Auth)* — Query users by email or name (minimum 2 characters). Used for team and project member invitations.

### 4. Workspaces (Private Workspaces)
- `GET /api/v1/workspaces` *(Auth)* — List user's private workspaces.
- `POST /api/v1/workspaces` *(Auth)* — Create private workspace.
  - Payload: `{ "name": string, "description"?: string }`
- `GET /api/v1/workspaces/{id}` *(Auth)* — Get workspace details.
- `PUT /api/v1/workspaces/{id}` *(Auth)* — Update workspace name/description.
- `DELETE /api/v1/workspaces/{id}` *(Auth)* — Delete workspace (fails if workspace `is_default: true`).

### 5. Teams & Membership
- `GET /api/v1/teams` *(Auth)* — List accessible teams.
- `POST /api/v1/teams` *(Auth, Superadmin)* — Create team.
  - Payload: `{ "name": string, "description"?: string }`
- `GET /api/v1/teams/{id}` *(Auth)* — Get team details.
- `PUT /api/v1/teams/{id}` *(Auth, Superadmin)* — Update team.
- `DELETE /api/v1/teams/{id}` *(Auth, Superadmin)* — Delete team.
- `GET /api/v1/teams/{id}/members` *(Auth)* — List team members with populated user profiles.
- `POST /api/v1/teams/{id}/members` *(Auth, Team Admin)* — Add/update member.
  - Payload: `{ "user_id": UUID, "role": "admin" | "member" }`
- `DELETE /api/v1/teams/{id}/members/{userId}` *(Auth, Team Admin)* — Remove member.

### 6. Projects & Isolation
- `GET /api/v1/teams/{teamId}/projects` *(Auth)* — List projects (strictly isolated).
- `POST /api/v1/teams/{teamId}/projects` *(Auth, Team Admin)* — Create project.
  - Payload: `{ "name": string, "description"?: string }`
- `GET /api/v1/projects/{id}` *(Auth)* — Get project details and caller's `user_role`.
- `PUT /api/v1/projects/{id}` *(Auth, Project Admin)* — Update project name/description.
- `DELETE /api/v1/projects/{id}` *(Auth, Project Admin)* — Delete project.
- `GET /api/v1/projects/{id}/members` *(Auth)* — List assigned members with populated user profiles (automatically includes parent team superadmin as a permanent project admin).
- `POST /api/v1/projects/{id}/members` *(Auth, Project Admin)* — Assign member with role.
  - Payload: `{ "user_id": UUID, "role": "admin" | "maintainer" | "contributor" | "reader" }`
- `DELETE /api/v1/projects/{id}/members/{userId}` *(Auth, Project Admin)* — Unassign member.

- `GET /api/v1/collections?workspace_id={id}&project_id={id}&include_items={bool}` *(Auth)* — List collections (filtered by `min_role`). Defaults to lightweight collection metadata (`include_items=false`) without items to prevent serverless payload overflows (`FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE`). Clients fetch each collection's items 1-by-1 via `GET /api/v1/collections/{id}`. Collection list/detail JSON may be gzip encoded when the client accepts it; responses set `Vary: Accept-Encoding` and `Cache-Control: private, no-store`. Identity responses are capped at 4 MiB, gzip responses at 3,000,000 bytes, and decoded serialization at 16 MiB. An accepted-but-oversized response returns `413 RESPONSE_PAYLOAD_TOO_LARGE`; excluding both identity and gzip returns `406 NOT_ACCEPTABLE`.
- `POST /api/v1/collections` *(Auth)* — Create collection.
  - Payload: `{ "workspace_id"?: UUID, "project_id"?: UUID, "name": string, "description"?: string, "min_role"?: ProjectRole }`
- `GET /api/v1/collections/{id}` *(Auth)* — Get collection with hierarchical nested items; response may be gzip encoded as above.
- `PUT /api/v1/collections/{id}` *(Auth)* — Update collection (enforces `base_version` OCC).
  - Payload: `{ "name": string, "description"?: string, "min_role"?: ProjectRole, "base_version": int64 }`
- `DELETE /api/v1/collections/{id}` *(Auth)* — Soft delete collection (tombstone).
- `POST /api/v1/collections/{id}/move` *(Auth)* — Move collection across scopes.
  - Payload: `{ "target_workspace_id"?: UUID, "target_project_id"?: UUID }`
- `PUT /api/v1/collections/{id}/reorder` *(Auth)* — Batch reorder items and folder parentage.
  - Payload: `{ "items": [{ "id": UUID, "parent_id": UUID|null, "sort_order": int }] }`
- `POST /api/v1/items` *(Auth)* — Create request or folder item.
  - Payload: `CollectionItem` schema.
- `GET /api/v1/items/{id}` *(Auth)* — Get item details.
- `PUT /api/v1/items/{id}` *(Auth)* — Update item (enforces `base_version` OCC).
  - Payload: `{ "item": CollectionItem, "base_version": int64 }`
- `DELETE /api/v1/items/{id}` *(Auth)* — Soft delete item (tombstone).

### 8. Environments & Variables
- `GET /api/v1/environments?workspace_id={id}&project_id={id}` *(Auth)* — List scoped environments.
- `POST /api/v1/environments` *(Auth)* — Create environment.
  - Payload: `{ "workspace_id"?: UUID, "project_id"?: UUID, "name": string, "variables": EnvironmentVariable[], "min_role"?: ProjectRole }`
- `GET /api/v1/environments/{id}` *(Auth)* — Get environment details.
- `PUT /api/v1/environments/{id}` *(Auth)* — Update environment (enforces `base_version` OCC).
  - Payload: `{ "name"?: string, "variables"?: EnvironmentVariable[], "min_role"?: ProjectRole, "base_version"?: int64 }`
- `DELETE /api/v1/environments/{id}` *(Auth)* — Soft delete environment (tombstone).
- **Initial Value vs. Current Value Protocol**:
  - The `variables` stored in backend environments represent the shared **Initial Value** (`value` / `initial_value`).
  - The client extension tracks a session-local **Current Value** (`currentValue`). Variable interpolation prioritizes `currentValue`. Dynamic script execution (`pm.environment.set()`) and token extractions mutate `currentValue` locally and do NOT push to the upstream backend.
  - Changes to upstream only occur when the user manually modifies an Initial Value or performs "Persist All" via the Environment Modal.

### 9. Stateless Delta Sync & Batch Operations
- `GET /api/v1/sync/pull?workspace_id={id}&since={timestamp}` (or `project_id`, never both) *(Auth)*
  - Returns all collections, items, and environments updated after `since`. Includes rows with `deleted_at != null` (tombstones).
  - Response: `{ "collections": Collection[], "items": CollectionItem[], "environments": Environment[], "server_time": string }`
  - Response may be gzip encoded when the client accepts it. Identity is capped at 4 MiB, gzip at 3,000,000 bytes, and decoded serialization at 16 MiB. An accepted-but-oversized response returns `413 RESPONSE_PAYLOAD_TOO_LARGE`; excluding both identity and gzip returns `406 NOT_ACCEPTABLE`.
- `POST /api/v1/sync/push` *(Auth)*
  - Applies up to 500 total offline mutations across all three arrays; exactly one scope is required. This is not an atomic transaction across mutations. Denied create/delete mutations are absent from `applied_ids`; update failures are reported in `conflicts`.
  - Evaluates OCC per mutation and returns conflict reports for stale entities without aborting valid ones.
  - Accepts identity JSON up to 4 MiB or one `Content-Encoding: gzip` member up to 3,000,000 bytes and 16 MiB after decoding. The body must contain exactly one JSON document. Unsupported content encoding returns `415 UNSUPPORTED_CONTENT_ENCODING`; malformed gzip or trailing JSON returns `400 BAD_REQUEST` before any mutation.
  - Response: `{ "applied_ids": UUID[], "conflicts": SyncConflictReport[], "server_time": string }`, bounded below 4 MiB. If needed, optional conflict `server_data` is omitted while `applied_ids`, conflict ID/type, and message remain available.
- `POST /api/v1/sync/import-batch` *(Auth)*
  - Claims offline LocalStorage collection tree and imports into cloud workspace/project.
  - Exactly one scope is required. The full request is atomic. Scope ownership, project/team memberships, and existing collection rows are locked in the same transaction/connection as writes.
  - Existing same-scope collections must be active and satisfy `min_role`; violations return `403 FORBIDDEN` and roll back all writes. Cross-scope IDs are remapped to fresh IDs without modifying the original resources.
  - Authorized imports increment existing versions without `base_version` OCC. A concurrent new-ID collision returns `409 CONFLICT`; retry the complete import. Existing item IDs in authorized active collections can be restored; deleted collections cannot be imported into.
  - Limits: 100 collections, 5,000 total nested items, 32 item levels, and an identity body of 4 MiB or one gzip member of 3,000,000 bytes/16 MiB decoded. The body must contain exactly one JSON document. Byte limit failures return `413 PAYLOAD_TOO_LARGE`; structural limit failures return `413 BATCH_LIMIT_EXCEEDED`, before writes. The extension submits multiple selected collections as separate atomic requests and reports partial progress; split or flatten an individual oversized collection before importing it.
  - Payload: `{ "workspace_id"?: UUID, "project_id"?: UUID, "collections": ImportCollectionRequest[] }`
  - Clients do not retry mutations after `415`, timeout, connection failure, or `413`; the server response is returned to the caller.

### Request limits and availability

All routes enforce a 4 MiB (4,194,304-byte) request body limit, including chunked bodies and bodies without `Content-Length`. `POST /api/v1/sync/push` and `POST /api/v1/sync/import-batch` additionally accept one gzip member: maximum 3,000,000 encoded bytes and 16 MiB decoded JSON. Oversize bodies return `413 PAYLOAD_TOO_LARGE`. At most 16 handlers run concurrently per instance; excess requests receive `503 SERVER_BUSY` and `Retry-After: 1`. A 30-second request deadline propagates to database work and returns `503 REQUEST_TIMEOUT`. These errors use the standard flat error envelope. Hosting/proxy limits can be smaller.

Sync failures do not return successful partial deltas. Role lookup and row iteration errors are propagated; result sets close before another connection is needed. Invalid scope returns 400; authorization returns 403; concurrent import collision returns 409; batch limits return 413; other sync/database failures return 500.

Serverless initialization permits one attempt at a time, with a 20-second deadline. Failed attempts retry after 1, 2, 4, 8, 16, then 30 seconds; successful initialization is reused. Requests during initialization/backoff receive `503` and `Retry-After: 1`. The existing startup error envelope is preserved as the exception to flat errors:

```json
{"success":false,"error":{"code":"SERVICE_UNAVAILABLE","message":"Failed to initialize database connection"}}
```

### 10. Admin Management (Superadmin Only)
- `GET /api/v1/admin/users` *(Auth, Superadmin)* — List all registered users.
- `POST /api/v1/admin/users` *(Auth, Superadmin)* — Provision new user with role (`superadmin` or `user`).
  - Payload: `{ "email": string, "password": string, "name": string, "role": SystemRole }`
- `PUT /api/v1/admin/users/{userId}/password` *(Auth, Superadmin)* — Reset user password directly.
  - Payload: `{ "password": string }`
- `DELETE /api/v1/admin/users/{userId}` *(Auth, Superadmin)* — Permanently remove user account, delete private workspaces, and safely reassign shared teams/projects to executing superadmin.

---

## 💾 Data Models & JSON Schemas

### 1. User
```typescript
interface User {
  id: string; // UUID
  email: string;
  name: string;
  avatar_url?: string | null;
  role: 'superadmin' | 'user';
  created_at: string; // ISO 8601 / RFC 3339
  updated_at: string;
}
```

### 2. Collection
```typescript
interface Collection {
  id: string; // UUID
  workspace_id?: string | null;
  project_id?: string | null;
  name: string;
  description?: string | null;
  min_role: 'admin' | 'maintainer' | 'contributor' | 'reader';
  version: number; // int64 OCC counter
  created_by: string; // UUID
  last_modified_by?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null; // Tombstone
  items?: CollectionItem[];
}
```

### 3. CollectionItem (Folders & Requests)
```typescript
interface CollectionItem {
  id: string; // UUID
  collection_id: string; // UUID
  parent_id?: string | null; // UUID of parent folder or null if root
  type: 'folder' | 'request';
  name: string;
  sort_order: number;
  method?: string; // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | etc.
  url?: string;
  params?: Array<{ id: string; key: string; value: string; enabled: boolean; description?: string }>;
  headers?: Array<{ id: string; key: string; value: string; enabled: boolean; description?: string }>;
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'apikey';
    bearerToken?: string;
    basicUsername?: string;
    basicPassword?: string;
    apiKeyKey?: string;
    apiKeyValue?: string;
    apiKeyIn?: 'header' | 'query';
  };
  body_type?: 'none' | 'json' | 'xml' | 'raw' | 'x-www-form-urlencoded' | 'form-data' | 'binary' | 'graphql';
  raw_type?: 'text' | 'json' | 'xml' | 'html';
  body_content?: string;
  graphql_query?: string | null;
  graphql_variables?: string | null;
  body_form_data?: any[];
  pre_request_script?: string | null;
  post_response_script?: string | null;
  version: number; // int64 OCC counter
  last_modified_by?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null; // Tombstone
  items?: CollectionItem[]; // Populated when type === 'folder'
}
```

### 4. Environment
```typescript
interface Environment {
  id: string; // UUID
  workspace_id?: string | null;
  project_id?: string | null;
  name: string;
  variables: Array<{
    id: string;
    key: string;
    value: string;
    enabled: boolean;
  }>;
  min_role: 'admin' | 'maintainer' | 'contributor' | 'reader';
  version: number; // int64 OCC counter
  last_modified_by?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null; // Tombstone
}
```

---

## ⚡ Verification & Testing Workflow

When testing your new backend against the AirREST Chrome Extension and Hub:

1. **Verify CORS**:
   Open Chrome DevTools Console from any webpage and run:
   ```javascript
   fetch('http://localhost:8080/api/v1/health')
     .then(r => r.json())
     .then(console.log);
   ```
   Must resolve `{ success: true, data: { status: "healthy", ... } }` without CORS errors.

2. **Verify Postman / AirREST Collection**:
   Import `backend/airrest_api_collection.json`. Set `baseUrl` to your server's address. Run:
   - `Superadmin Login` -> should extract JWT token to environment.
   - `List Private Workspaces` -> should return default workspace.
   - `Create Team` -> should succeed.
   - `Pull Delta` -> should return collections, items, environments, and server_time.

3. **Verify in Chrome Extension**:
   - Open AirREST Extension settings.
   - Set **Cloud API URL** to your backend URL.
   - Log in with your Superadmin account.
   - Trigger manual sync or import a collection.
   - Check that collections and environments appear in the sidebar.

4. **Verify in AirREST Hub**:
   - Open AirREST Hub (`npm run dev:hub`).
   - Log in using your backend URL.
   - Manage teams, projects, and member permissions.

---

## 🛠️ Code Generation from OpenAPI Contract

You can automatically scaffold server stubs in any language using [OpenAPI Generator](https://openapi-generator.tech):

### Java (Spring Boot)
```bash
npx @openapitools/openapi-generator-cli generate \
  -i backend/openapi.yaml \
  -g spring \
  -o backend-java \
  --additional-properties=basePackage=id.adiputera.airrest,interfaceOnly=true,useSpringBoot3=true
```

### Python (FastAPI)
```bash
npx @openapitools/openapi-generator-cli generate \
  -i backend/openapi.yaml \
  -g python-fastapi \
  -o backend-python
```

### TypeScript (NestJS / Express)
```bash
npx @openapitools/openapi-generator-cli generate \
  -i backend/openapi.yaml \
  -g typescript-nestjs \
  -o backend-nestjs
```

### C# (ASP.NET Core)
```bash
npx @openapitools/openapi-generator-cli generate \
  -i backend/openapi.yaml \
  -g aspnetcore \
  -o backend-csharp
```

### Rust (Axum)
```bash
npx @openapitools/openapi-generator-cli generate \
  -i backend/openapi.yaml \
  -g rust-axum \
  -o backend-rust
```
