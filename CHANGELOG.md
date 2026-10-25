# Changelog

All notable changes to AirREST will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.2] - 2026-10-25

### Added
- **RBAC Authority & Scope Enforcement in Chrome Extension**:
  - Implemented client-side authority verification using scope rank hierarchy (`Superadmin`/`Admin` [Rank 4] > `Maintainer` [Rank 3] > `Contributor` [Rank 2] > `Reader` [Rank 1]).
  - Read-only protection for `reader` role in Project scope: suppresses collection/environment creation and import actions.
  - Granular collection `minRole` compliance checking across optimistic store actions and UI components.
  - Added dedicated read-only indicator badge and lock icons in `RequestEditor`, `Sidebar`, and collection headers.
  - In `RequestEditor`, replaced the direct *Save* action with a **Read-only** indicator when the active request belongs to a read-only collection, while keeping **Save As** active so users can save a copy to personal or offline workspaces.
  - In `Sidebar`, disabled drag-and-drop reordering, inline renaming, and destructive actions (delete/move) for read-only collections and items.
  - In `MoveCollectionModal` and `MoveRequestModal`, blocked moving items out of or into read-only scopes/collections with informative alert banners.
- **Progressive Capability-Based Permissions (Jalur A)**:
  - Transitioned client authorization from rigid integer rank comparisons to a granular capability permission model (`permissions: string[]`).
  - Backend computes and serializes permissions (`collection:read`, `collection:write`, `collection:delete`, `collection:move`, `env:read`, `env:write`, `env:delete`, `*`) on `Project` and `ProjectMember` objects without modifying the PostgreSQL database schema.
  - Added declarative `hasScopePermission(scope, permission, workspaceMode, userRole)` helper in the Extension with seamless fallback to `DEFAULT_ROLE_PERMISSIONS` and offline scope bypass.
  - Synchronized `backend/openapi.yaml`, `backend/openapi.json`, and `backend/API_CONTRACT.md` documentation.

### Fixed
- **Value Checking & Crash Prevention**:
  - **JWT Base64url Padding**: Added automatic base64 padding (`base64.length % 4`) in `jwt.ts` before decoding with `atob()`, preventing `DOMException` failures on unpadded base64url JWTs (~50% of tokens).
  - **Form-Data File Deserialization**: Added `instanceof Blob` validation in `fetcher.ts` before calling `formData.append()`, preventing fatal crashes on deserialized empty `{}` file attachments from history or IndexedDB.
  - **Unicode Basic Auth**: Wrapped Basic Auth `btoa` encoding in UTF-8 escaping in `fetcher.ts` to prevent crashes on non-ASCII username/password credentials.
  - **Gateway HTML Error Handling**: Implemented safe JSON parsing fallback (`safeJson`) across all endpoints in `cloudApi.ts`, preventing unhandled `SyntaxError` crashes when reverse proxies or gateways return HTML error pages (502 Bad Gateway / 503 / 504).
  - **Sandbox Prototype Pollution Guard**: Hardened sandbox script execution in `sandbox.html` against prototype pollution on `pm.environment.set` and `pm.variables.set` (`__proto__`, `prototype`, `constructor`), and guarded message `targetOrigin`.
  - **Safe URL & Parameter Extraction**: Guarded `indexOf` and `substring` in `urlParams.ts`, and protected `new URL(url).pathname` in `ResponseViewer.tsx` from crashing on parameterized or malformed sample URLs.
  - **Formatter & Postman Value Guards**: Added string type guards prior to `.trim()` across XML, JSON, and GraphQL formatters in `formatters.ts`, and sanitized key/value pairs in `postman.ts`.
  - **Request Diff & Tree Helper Null Safety**: Added guards against undefined collection items in `requestDiff.ts` and `treeHelper.ts` to ensure render stability during rapid tab switching.
  - **VariableInput Safe Value**: Handled undefined/null values in `VariableInput.tsx` to prevent `Cannot read properties of undefined (reading 'length')`.
  - **Service Worker Messaging Resilience**: Corrected asynchronous message response handling in `service-worker.js` and wrapped window/tab update handlers in `try/catch`.
- **Extension Code Audit & Authority Hardening**:
  - **Authority Signature Synchronization**: Unified all `canModifyCollection` calls across `useApiStore.ts`, `RequestEditor.tsx`, `MoveRequestModal.tsx`, `MoveCollectionModal.tsx`, and `SaveToCollectionModal.tsx` to pass the full authority context (`activeScope`, `workspaceMode`, `userRole`), ensuring granular capability checks (`collection:write`) are always enforced.
  - **Environment Modification Safeguards**: Added mandatory `env:write` permission checks before optimistic mutations in `addEnvironmentVariable`, `updateEnvironmentVariable`, `removeEnvironmentVariable`, `addEnvironment`, and `replaceEnvironment` to prevent 403 desyncs.
  - **Import & Conflict Authority Enforcement**: Enforced `collection:write` and `env:write` capability checks in `ImportModal.tsx`, `importEnvironmentFromJson`, `importAnyPostmanJson`, and `importCollectionFromJson` before importing, cloning as copy, or replacing existing collections/environments.
  - **Collection Move to Offline Guard**: Protected `moveCollection` when moving out of a cloud project into an offline workspace by requiring `collection:move` and syncing deletion to the cloud project.
  - **Fetcher & cURL Null Safety**: Guarded `params`, `headers`, `auth`, and `url` against undefined or null properties in `prepareRequest`, `executeApiRequest`, and `generateCurlCommand`.
  - **React Crash Prevention**: Added null-safe fallbacks for `currentTab.params`, `currentTab.headers`, `currentTab.auth`, and `currentTab.bodyUrlEncoded` in `RequestEditor.tsx`, `ResponseViewer.tsx` (headers mapping), `VariableInput.tsx` (env variables loop), `KeyValueEditor.tsx` (items loop), and `postman.ts` (collection items and env values export).
  - **Sandbox Timeout & Document Guard**: Added document availability check and an interval timeout limit to `getSandboxIframe()` in `scriptRunner.ts` to prevent infinite background loops.
- **Second Audit Pass Hardening & Error Boundary**:
  - **Global & Panel-Level React Error Boundaries**: Added dedicated [`ErrorBoundary.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/components/ErrorBoundary.tsx) component with dark-mode styling, error isolation, "Try Again" state reset, "Reload AirREST" action, and collapsible technical call stack traces. Wrapped `Header`, `Sidebar`, and the studio panel in [`App.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/App.tsx) to prevent single-component errors from bricking the extension.
  - **Sidebar Search Crash Elimination**: Guarded `item.name`, `item.request?.url`, and `item.request?.method` in `filterCollectionItems` and `filteredHistory` in [`Sidebar.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/components/Sidebar.tsx). Replaced unhandled `col.items.length` and recursive traversal iterations with null-safe array fallbacks `(col.items || [])`.
  - **ScopeSwitcher Search Robustness**: Added string fallbacks for `w.name`, `p.name`, `team.name`, and `proj.name` in [`ScopeSwitcher.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/components/ScopeSwitcher.tsx) to prevent crash hazards during scope filtering.
  - **100% Dynamic Capability Permissions Transition**: Fully eliminated static integer `userRank` and `ROLE_RANK` lookups across all extension components and Zustand store mutations (`useApiStore.ts`, `Sidebar.tsx`, `RequestEditor.tsx`, `EnvironmentModal.tsx`, `MoveRequestModal.tsx`, `MoveCollectionModal.tsx`, `SaveToCollectionModal.tsx`, `ImportModal.tsx`, `Header.tsx`). Replaced with purely capability-driven helpers [`canModifyCollection`](file:///Users/adiputera/master_git/AirREST/extension/src/lib/jwt.ts#L137-L184) and [`canModifyEnvironment`](file:///Users/adiputera/master_git/AirREST/extension/src/lib/jwt.ts#L186-L213) that evaluate `collection:write`, `env:write`, `collection:delete`, and `*` dynamically against active scope capabilities.
  - **Profile & Modal Value Hardening**: Guarded against double-space name parsing in [`UserMenu.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/components/UserMenu.tsx) avatar fallback and null-guarded incoming environment comparisons in [`EnvironmentModal.tsx`](file:///Users/adiputera/master_git/AirREST/extension/src/components/EnvironmentModal.tsx).

---

## [1.1.1] - 2026-10-22

### Added
- **Superadmin User Deprovisioning & Deletion**:
  - Added `DELETE /api/v1/admin/users/{userId}` backend endpoint with `RequireSuperadmin` authorization.
  - Implemented safe atomic database transaction in PostgreSQL: reassigns created teams, projects, and collections to the executing superadmin, clears last modified metadata, and cascades removal of private workspaces and team/project memberships.
  - Added guardrails preventing self-deletion and preventing deletion of the last superadmin on the platform.
  - Added **Delete User** action button and interactive confirmation modal in AirREST Hub's Superadmin Console (`SuperadminView.tsx`).
- **Resilient Client Auth Eviction & Auto-Recovery**:
  - Implemented client-side auth eviction callbacks (`registerAuthEvictedCallback` in Extension, `registerHubAuthEvicted` in Hub).
  - When an account is deleted or refresh token is rejected with HTTP 401/403, the client automatically evicts stale credentials, safely switches to the local offline workspace, and displays an informative notification.
  - Network-resilience guard: Transient network disconnects, offline state, or 5xx server errors do NOT evict user sessions, allowing automatic sync retry once reconnected.
- **User Profile Menu & In-App Change Password**:
  - Added interactive user menu in the top navigation bar. When unauthenticated, it persistently displays a **Sign In** action to open cloud login; when authenticated, it displays the user profile avatar, name, email, and role badge.
  - Added **Change Password** modal (`ChangePasswordModal.tsx`) communicating with `PUT /api/v1/auth/password` with validation (minimum 8 characters, password matching, and current password verification).
  - Added **Sign Out** action with confirmation dialog to safely disconnect credentials and clear cached cloud session data.
- **Collection, Folder & Request In-Place Renaming & 3-Dots Menu**:
  - Replaced crowded collection action buttons with a consolidated 3-dots (`MoreVertical`) options menu.
  - Added in-place inline renaming for collections, folders, and requests in the sidebar with keyboard shortcuts (`Enter` to save, `Escape` to cancel) and confirmation buttons.
  - Added double-click shortcut directly on collection, folder, and request labels to quickly initiate renaming.
  - Automatically synchronizes tab headers and open request titles when renamed from the sidebar.

### Changed
- **UI Customization & Component Polish**:
  - Refined dropdown menus, header actions, and trigger buttons across ScopeSwitcher, Workspace Switcher, and Sidebar navigation.
  - Improved button padding, hover states, border accents, and active scope indicators for a cleaner, modern aesthetic.
- **Serverless Cloud Sync Payload Optimization**:
  - Transitioned cloud pull synchronization to lightweight collection metadata listing followed by 1-by-1 collection detail fetching (`fetchScopeCollections` + `fetchCollectionById`).
  - Completely prevents Vercel serverless `FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE` (4.5 MB response payload limit) errors for workspaces with extensive request trees.

---

## [1.1.0] - 2026-10-21

### Added
- **Request Relocation (Move Request Modal)**:
  - Added an interactive modal (`MoveRequestModal`) to relocate individual requests across collections and nested subfolders.
  - Quick-action move icon on request item hover in the sidebar tree.
  - Current location badge and hierarchical folder breadcrumbs to simplify target selection.
  - Smart re-saving in `SaveToCollectionModal`: updating an already-saved request to a new location moves the item instead of creating duplicate records.
- **Drag-and-Drop Sidebar Tree Reordering**:
  - Reorder requests and nested folders within any collection using native HTML5 Drag and Drop.
  - Sibling positioning indicators (`before` and `after`) with active blue indicator lines.
  - Folder nesting indicator (`inside`) with distinct hover highlights and an empty-folder drop target.
  - **Cross-Collection Boundary Guard**: Dragging across collection boundaries displays a `not-allowed` cursor and prevents accidental drops.
  - **Circular Hierarchy Guard**: Prevents moving a parent folder into itself or any of its descendants with immediate `not-allowed` feedback.
- **Database Concurrency Resilience**:
  - Top-down transaction lock acquisition (`collections` $\rightarrow$ `collection_items`) in PostgreSQL `BatchReorderItems` to prevent deadlock conflicts.
  - Deterministic item ID sorting prior to batch execution to ensure uniform row-lock acquisition.
  - Automatic transaction retry up to 3 times with exponential backoff for transient deadlock/serialization errors (`SQLSTATE 40P01` / `40001`).
- **Client Auto-Recovery & Concurrency Resilience**:
  - Automatic single-retry mechanism in frontend for transient cloud reorder sync failures.
  - Self-clearing error banner upon subsequent successful synchronization operations.
  - **Environment OCC Sync Resilience**: Implemented version tracking (`version`) on frontend `Environment` models and added 300ms debouncing for variable edits to eliminate false self-conflicts during repeated edits.
  - Automatic recovery and single-retry with latest remote version upon receiving HTTP 409 Conflict.
  - Added backend fallback in `EnvironmentService.Update` defaulting `base_version` to `existing.Version` when omitted or non-positive.

### Changed
- **Smart Workspace Caching**:
  - Extended workspace scopes and project list cache TTL from 1 hour to 12 hours (`SCOPE_CACHE_TTL_MS` & `SCOPES_LIST_CACHE_TTL_MS`), optimizing background network traffic for daily fetch schedules.
  - Preserved instant manual refresh via the Scope Switcher "Sync Now" button.

---

## [1.0.0] - 2026-10-21

### Added
- **Multi-Offline Workspaces**:
  - Isolated offline workspaces with dedicated tabs, collections, environments, and histories.
  - Workspace management modal with search, creation, editing, cloning/duplication, and deletion.
- **Postman Compatibility**:
  - Full import and export compatibility with Postman Collection format v2.1.0 and Environment JSON files.
- **Dual Architecture Editions**:
  - **Full Edition**: Dual-mode supporting both offline storage and self-hosted cloud synchronization (Go backend & AirREST Hub).
  - **Offline Edition**: 100% air-gapped, local-only edition featuring emerald branding and zero network calls to external cloud backends.
- **In-Browser HTTP Engine**:
  - Direct request dispatching without CORS restrictions via Chrome Extension permissions.
  - Full HTTP method support: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
  - Body support: JSON (with format & syntax validation), GraphQL (queries & variables), XML, URL-encoded, Form-Data (file attachments), and raw binary.
  - URL parameter and header tables with dynamic variable interpolation (`{{variable}}`, `{{$guid}}`, `{{$timestamp}}`).
- **Sandboxed Test & Pre-Request Scripting**:
  - Isolated script execution in an iframe sandbox with Postman-compatible `pm.*` API assertions (`pm.test`, `pm.expect`, `pm.environment`, `pm.variables`).
- **Cloud Synchronization & Team Workspaces**:
  - Team projects with Role-Based Access Control (`Admin`, `Maintainer`, `Contributor`, `Reader`).
  - Optimistic Concurrency Control (OCC) with version-checked updates.
  - Rolling 30-day refresh tokens for persistent authenticated sessions.
