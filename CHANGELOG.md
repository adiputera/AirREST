# Changelog

All notable changes to AirREST will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.1.8] - 2026-10-30

### Added
- **Hub-managed Collection Feature Controls**:
  - Added global controls for moving, deleting, and exporting cloud collections: `collection.move`, `collection.delete`, and `collection.export`.
  - Added a Superadmin Feature Controls panel with revision-aware saves, plus backend policy storage, audit records, and optimistic-concurrency protection.
  - Enforced move and delete policy server-side, including sync deletions, so older clients cannot bypass a disabled control.
  - Refreshed client policy on login, scope changes, manual Sync Online, every 30 minutes, and immediately after a `FEATURE_DISABLED` response.

### Changed
- **Collection Move Direction**:
  - Personal offline or cloud collections can move into eligible team projects.
  - Collections in a project cannot move into a personal cloud or offline workspace; the backend enforces the cloud restriction and the client omits personal targets.
- **Desktop Release Metadata**:
  - Bumped the desktop application to `v0.1.3` across its package, Tauri, and Cargo metadata.

## [1.1.7] - 2026-10-30

### Added
- **Universal Collection & Request Search in Sidebar**:
  - Upgraded sidebar collection search into an all-in-one universal search filtering across collections, folders, request names, HTTP methods (e.g. `GET`, `POST`), and URL endpoints.
  - Added multi-token query parsing (`split(/\s+/)`), supporting composite queries such as `GET /users`, `POST login`, or specific endpoint paths.
  - Automatically expands matching collections and folders recursively when search terms match.
  - Added quick-clear button (`X`) and `Escape` keyboard shortcut to reset search immediately.
  - Updated placeholder to `"Search collections or requests..."` in [`Sidebar.tsx`](packages/common/src/components/Sidebar.tsx) across `@airrest/common` and extension.
  - Added unit test suite `test:sidebar-search` in [`scripts/sidebar-search.test.mjs`](scripts/sidebar-search.test.mjs).
- **Collection Indicator & Visual Context in Editor & Tabs**:
  - Added a collection badge indicator with folder icon next to the active request name in [`RequestEditor.tsx`](packages/common/src/components/RequestEditor.tsx).
  - Enhanced tab hover tooltips in [`TabBar.tsx`](packages/common/src/components/TabBar.tsx) to display the request's parent collection: `${name} (${collection.name})`.
- **In-Memory Tab Response Persistence**:
  - Maintained runtime response cache (`tabResponses: Record<string, ApiResponse>`) mapped per tab ID in `useApiStore.ts`.
  - Switching between tabs automatically restores each tab's executed response without re-sending the request.
  - Closing a tab cleans up its cached response and automatically revokes binary `blobUrl` handles.
  - Omitted `tabResponses` and `activeResponse` from `partialize` so responses remain session-only and never leak into persistent storage.
  - Supported passing historical responses directly into tabs via `openRequestInTab(request, response)` when clicking History entries in [`Sidebar.tsx`](packages/common/src/components/Sidebar.tsx).
  - Added unit test suite `test:tab-response-cache` in [`scripts/tab-response-cache.test.mjs`](scripts/tab-response-cache.test.mjs).
- **Zero-Tabs Empty State Studio**:
  - Allowed closing all open tabs via `closeTab` and `closeAllTabs`, transitioning to `tabs: []` instead of forcing a reset tab.
  - Built [`EmptyStudioView.tsx`](packages/common/src/components/EmptyStudioView.tsx) displaying a clean, branded empty state when no tabs are open with quick actions to create a new tab or jump to collections/history.
  - Added null-safe guards in [`RequestEditor.tsx`](packages/common/src/components/RequestEditor.tsx) and updated [`App.tsx`](packages/common/src/App.tsx) to switch between the active editor and the empty state.
  - Added automated tests `T-SEMI-PERSIST-6`, `T-SEMI-PERSIST-7`, and `T-SEMI-PERSIST-8` in [`scripts/tab-response-cache.test.mjs`](scripts/tab-response-cache.test.mjs).
- **Tauri Desktop Client Auto-Updater & Linux Packaging**:
  - Integrated `@tauri-apps/plugin-updater` with in-app banner notification (`DesktopUpdateBanner.tsx`), background download staging, and clean restart prompt.
  - Added automated test suite `T-UPDATER-1` through `T-UPDATER-6` in [`scripts/desktop-updater.test.mjs`](scripts/desktop-updater.test.mjs).
  - Bumped desktop app release to `v0.1.2` across `apps/desktop/package.json`, `tauri.conf.json`, and `Cargo.toml`.

### Fixed
- **Multi-Tab Request Isolation & Tab Overwrite Elimination**:
  - Resolved an issue where opening requests with identical names, methods, or URLs from different collections (e.g. `get token` from Collection A and `get token` from Collection B) reused the existing tab instead of opening a new tab.
  - Replaced ambiguous name/method/URL matching in `openRequestInTab` with strict unique ID tab matching (`targetId ? state.tabs.find(t => t.id === targetId) : undefined`).
  - Added `isTargetDifferentCollection` guard in [`SaveToCollectionModal.tsx`](packages/common/src/components/SaveToCollectionModal.tsx) to ensure saving a request to a different collection generates a new UUID, preventing cross-collection item ID collisions.
  - Added `ensureUniqueCollectionItemIds` during storage hydration in `useApiStore.ts` to automatically de-duplicate any legacy colliding item IDs across collections.
  - Added automated regression test `T-TAB-ISOLATION` in [`scripts/desktop-transport-lifecycle.test.mjs`](scripts/desktop-transport-lifecycle.test.mjs).

## [1.1.6] - 2026-10-30

### Added
- **Request Name & HTTP Method Duplicate Guard & Conflict Resolution**:
  - Implemented intra-collection duplicate detection enforcing uniqueness on `(HTTP method, request name)` (case-insensitive for both method and trimmed name).
  - Distinct HTTP methods with the same name (e.g. `POST token` and `GET token`) are allowed to coexist naturally within the same collection without prompt.
  - When saving or saving-as a request that collides with an existing request's method and name in the target collection, a conflict dialog is displayed (*"Request already exists: replace or save copy?"*).
  - Provides two distinct resolution actions:
    - **Save Copy**: Auto-generates a non-conflicting incremented copy name (e.g. `token (Copy)` or `token (Copy 2)`) using `generateCopyRequestName`, assigns a fresh UUID, and preserves the existing request intact.
    - **Replace**: In-place overwrites the existing conflicting request's payload while maintaining its ID and folder hierarchy.
    - **Back**: Returns to the modal form allowing the user to modify the name or destination.
  - Integrated duplicate collision detection in [`SaveToCollectionModal.tsx`](packages/common/src/components/SaveToCollectionModal.tsx) and [`RequestEditor.tsx`](packages/common/src/components/RequestEditor.tsx) across `packages/common` and `extension`.
  - Added automated test suite `T-SAVE-CONFLICT-DETECTION` in [`scripts/desktop-transport-lifecycle.test.mjs`](scripts/desktop-transport-lifecycle.test.mjs).
- **Multiple Online Personal Workspaces UI & Full Management**:
  - Implemented complete UI workflows for creating, renaming, and deleting multiple Online Personal Workspaces in [`ScopeSwitcher.tsx`](packages/common/src/components/ScopeSwitcher.tsx) across `@airrest/common` and the Chrome Extension.
  - Added inline workspace creation (`+ New`) with keyboard shortcuts (`Enter` to submit, `Escape` to cancel) and auto-focus input fields.
  - Added contextual actions menu per personal workspace with inline rename support and delete protection.
  - Guarded default workspaces against deletion with an explicit `Default` pill badge, while non-default personal workspaces prompt a styled confirmation modal ([`ConfirmModal.tsx`](packages/common/src/components/ConfirmModal.tsx)) before deletion.
  - Added `createCloudWorkspace`, `updateCloudWorkspace`, and `deleteCloudWorkspace` API transport methods and integrated store actions in `useApiStore.ts`.
- **Monorepo Migration & Shared Core Architecture**:
  - Re-architected the repository into a clean monorepo structure with `@airrest/common` (`packages/common/`), Chrome Extension (`extension/`), Hub Web Portal (`hub/`), and Desktop Client (`apps/desktop/`).
  - Extracted shared domain models, Zustand state store, universal UI components, cURL/Postman transformers, and runtime factory into private ESM package `@airrest/common`.
  - Added extensible `PlatformAdapter` contract decoupling UI and store layers from host platform APIs (`TestTransport`, `CloudTransport`, `ScriptExecutor`, native file system, and origin permission checks).
- **Tauri v2 Desktop Application & Sandbox Hardening (`apps/desktop/`)**:
  - Implemented standalone desktop client powered by Tauri v2 with Rust backend shell.
  - Native HTTP transport via `@tauri-apps/plugin-http` with opt-in SSL verification bypass for local testing and full custom `Cookie`, `User-Agent`, and `Host` headers.
  - Web Worker offloaded WebAssembly scripting engine (`quickjs.worker.ts` + `quickjsRunner.ts`), executing guest scripts off the main thread with 64 MiB heap and 512 KiB stack boundaries.
  - Strict boundary validation via `scriptProtocol.ts`: 256 KiB script limit, 1 MiB serialized UTF-8 input/output bounds, prototype pollution guards (`__proto__`, `constructor`, `prototype`), and captured immutable primitives.

### Fixed
- **Save As Duplicate Creation & Independence**:
  - Resolved an issue where using **Save As** to save a request into another collection triggered a `moveRequest`, removing the original request from the source collection instead of duplicating it.
  - Resolved an issue where saving a copy to the same collection overwritten the existing request due to `item.name === cleanReq.name` matching in `saveRequestToCollection`.
  - Added explicit `isSaveAs` mode to [`SaveToCollectionModal.tsx`](packages/common/src/components/SaveToCollectionModal.tsx) and [`RequestEditor.tsx`](packages/common/src/components/RequestEditor.tsx), ensuring **Save As** always generates a new UUID and preserves the original item in the source collection.
  - Removed name-based item matching in `saveRequestToCollection` across [`packages/common/src/store/useApiStore.ts`](packages/common/src/store/useApiStore.ts) and [`extension/src/store/useApiStore.ts`](extension/src/store/useApiStore.ts), allowing multiple requests with the same name to coexist safely with distinct IDs.
  - Synchronized `activeTabId` in `updateActiveRequest` when `id` changes so that the active tab points to the new duplicated request without desynchronizing editor state.
  - Added automated test suite `T-SAVE-AS-DUPLICATE` in [`scripts/desktop-transport-lifecycle.test.mjs`](scripts/desktop-transport-lifecycle.test.mjs).
- **Reader Scope Save As & Read-Only Enforcement**:
  - Fixed an issue where the **Save As** button remained visible in [`RequestEditor.tsx`](packages/common/src/components/RequestEditor.tsx) when the user had a `reader` role in project scope, causing an `insufficient permission` error upon attempting to save.
  - Guarded the **Save As** button and `handleSave` in `RequestEditor` with `canWriteScope` (`hasScopePermission(activeScope, 'collection:write')`), ensuring read-only project scopes display the locked `Read-only` badge without offering `Save As` or allowing `Ctrl+S`/`Cmd+S` saves.
  - In [`SaveToCollectionModal.tsx`](packages/common/src/components/SaveToCollectionModal.tsx), disabled collection creation and saving when the scope lacks `collection:write`, marked restricted collections as `(Read-only)` in the dropdown, and ensured saving a copy does not trigger relocation (`moveRequest`) on read-only source collections.
  - Added unit test in [`security-client.test.mjs`](scripts/security-client.test.mjs) verifying reader capability boundaries in cloud project scopes.
- **Empty Scope & Null Delta Response Resilience**:
  - Resolved a cloud sync failure where switching to an empty workspace/project scope, or logging in as a user without assigned teams or collections, caused the sync button to change permanently to **Retry** with repeating failures despite receiving HTTP 200 success from the backend.
  - Updated `fetchScopeCollections` in [`cloudApi.ts`](packages/common/src/lib/cloudApi.ts) to gracefully treat `null` or missing response payloads as empty arrays (`[]`) instead of throwing validation exceptions.
  - Hardened backend JSON serialization in [`response.go`](backend/pkg/response/response.go) using reflection to automatically normalize `nil` slices into empty slices (`[]any{}`), ensuring list endpoints consistently serialize `"data": []` rather than `"data": null`.
  - Initialized slice buffers with `make([]*Type, 0)` across all PostgreSQL repositories (`collection_repo.go`, `environment_repo.go`, `project_repo.go`, `team_repo.go`, `user_repo.go`, `workspace_repo.go`) and added fallback guards across all service list handlers.
  - Added unit test suite in [`response_test.go`](backend/pkg/response/response_test.go) verifying nil-slice array marshaling.
- **Scope Switcher Team Projects Auto-Loading**:
  - Fixed an issue in [`ScopeSwitcher.tsx`](packages/common/src/components/ScopeSwitcher.tsx) and [`useApiStore.ts`](packages/common/src/store/useApiStore.ts) where expanding a team accordion in the desktop app failed to auto-load projects from the backend.
  - Corrected `fetchScopes` to prevent un-fetched teams from polluting `scopesCache.teamProjects` with empty arrays (`[]`), ensuring un-fetched teams remain `undefined` until loaded.
  - Added robust loaded state tracking (`fetchedTeamsRef`) so that expanding a team triggers `fetchProjectsForTeam(teamId, true)` whenever its projects have not yet been populated.
  - Added auto-fetch logic when the active scope is an un-fetched project team upon opening the Scope Switcher.
  - Enhanced the team accordion UI to display a dedicated spinner while loading, an interactive "Click to load projects" fallback if unloaded, and project counts once loaded.
- **File Picker & Import Dialog Flow**:
  - Resolved an issue in [`ImportModal.tsx`](packages/common/src/components/ImportModal.tsx) where clicking the file chooser button in non-desktop environments (Chrome extension, web) failed to open the file selection dialog due to unconditional native dialog interception.
  - Guarded native dialog invocation against `adapter?.capabilities?.supportsNativeFileSystem`, falling back to standard HTML file inputs for browser and extension runtimes.
  - Added drag-and-drop support (`onDragOver`, `onDragEnter`, `onDrop`) to the Postman import dropzone.
  - Implemented DOM-based file input fallback in `chromeAdapter.openFile` and unified native/web import flows in [`EnvironmentModal.tsx`](packages/common/src/components/EnvironmentModal.tsx).

### Changed
- **Standardized Default Workspace Naming**:
  - Standardized the naming convention of default private workspaces to `Default Workspace` across all roles (including superadmin bootstrap and standard user registration in `auth_service.go`), replacing ambiguous role-based titles (`Superadmin Workspace`, `My Workspace`).
  - Added database migration `006_standardize_default_workspaces.sql` migrating existing legacy private workspace names to `Default Workspace`.
  - Updated API contract documentation in [`API_CONTRACT.md`](backend/API_CONTRACT.md) and project documentation in [`README.md`](README.md).
- **Collection Transfer Compression**:
  - Cloud collection import and sync push now gzip eligible JSON payloads, with separate encoded and decoded size budgets; identity remains available when it is the smaller valid representation.
  - Collection list, detail, and delta pull responses support negotiated gzip with bounded identity, gzip, and decoded serialization sizes.
  - Malformed gzip payloads and requests containing more than one JSON document are rejected before collection mutations; successful collection responses are parsed with a decoded-size cap.
  - Enabled gzip support in the desktop HTTP transport and added browser/client, backend, and PostgreSQL integration coverage for compressed collection transfer.

### Added
- **Multiple Online Personal Workspaces UI & Full Management**:
  - Implemented complete UI workflows for creating, renaming, and deleting multiple Online Personal Workspaces in [`ScopeSwitcher.tsx`](packages/common/src/components/ScopeSwitcher.tsx) across `@airrest/common` and the Chrome Extension.
  - Added inline workspace creation (`+ New`) with keyboard shortcuts (`Enter` to submit, `Escape` to cancel) and auto-focus input fields.
  - Added contextual actions menu per personal workspace with inline rename support and delete protection.
  - Guarded default workspaces against deletion with an explicit `Default` pill badge, while non-default personal workspaces prompt a styled confirmation modal ([`ConfirmModal.tsx`](packages/common/src/components/ConfirmModal.tsx)) before deletion.
  - Added `createCloudWorkspace`, `updateCloudWorkspace`, and `deleteCloudWorkspace` API transport methods and integrated store actions in `useApiStore.ts`.
- **Monorepo Migration & Shared Core Architecture**:
  - Re-architected the repository into a clean monorepo structure with `@airrest/common` (`packages/common/`), Chrome Extension (`extension/`), Hub Web Portal (`hub/`), and Desktop Client (`apps/desktop/`).
  - Extracted shared domain models, Zustand state store, universal UI components, cURL/Postman transformers, and runtime factory into private ESM package `@airrest/common`.
  - Added extensible `PlatformAdapter` contract decoupling UI and store layers from host platform APIs (`TestTransport`, `CloudTransport`, `ScriptExecutor`, native file system, and origin permission checks).
- **Tauri v2 Desktop Application & Sandbox Hardening (`apps/desktop/`)**:
  - Implemented standalone desktop client powered by Tauri v2 with Rust backend shell.
  - Native HTTP transport via `@tauri-apps/plugin-http` with opt-in SSL verification bypass for local testing and full custom `Cookie`, `User-Agent`, and `Host` headers.
  - Web Worker offloaded WebAssembly scripting engine (`quickjs.worker.ts` + `quickjsRunner.ts`), executing guest scripts off the main thread with 64 MiB heap and 512 KiB stack boundaries.
  - Strict boundary validation via `scriptProtocol.ts`: 256 KiB script limit, 1 MiB serialized UTF-8 input/output bounds, prototype pollution guards (`__proto__`, `constructor`, `prototype`), and captured immutable primitives.
  - Safe `console.log/info/warn/error/debug` stubs ensuring snippet compatibility without host leakage.
  - Release CSP hardening in `tauri.conf.json` (`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob;`).
  - Native file system integration via `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-fs` with byte-for-byte binary parity and user cancellation differentiation.
  - Cloud redirect protection (`maxRedirections: 0`, `redirect: 'manual'`) preventing credential forwarding on HTTP 3xx responses.
  - State isolation through `createApiStore` store factory and `StoreContext` provider.
- **Automated Monorepo Testing & Gated Spikes**:
  - Added Gate P0.1 & P0.2 test suite (`scripts/desktop-transport-lifecycle.test.mjs`) verifying native transport, header echo, 10 MiB bounded streaming, cancellation, and runtime isolation.
  - Added Gate P0.3 test suite (`scripts/desktop-quickjs-sandbox.test.mjs`) directly importing production runner modules and testing memory bounds, prototype defense, and interruption.
  - Added `npm run test:all` consolidating 72 unit and integration tests across extension, hub, and desktop.

---

## [1.1.5] - 2026-10-28

### Changed
- **Chrome Web Store Permissions Alignment**:
  - Removed unused `storage` permission from `extension/public/manifest.json` in accordance with the Chrome Web Store minimal permissions policy (Purple Potassium review guidance).
  - All local collections, environments, tabs, and execution history continue to persist securely and durably via IndexedDB (`airrest-db`) with `unlimitedStorage` quota protection.

---

## [1.1.4] - 2026-10-27

### Added
- **Request Lifecycle Safeguards & Cancellation**:
  - Added dedicated **Scripts** tab in `ResponseViewer` that automatically activates upon pre-request script errors with clear feedback (`Pre-request Script Failed — Request not sent`), immediately halting HTTP execution.
  - Implemented request cancellation via `AbortController` and an interactive **Cancel** button in `RequestEditor` for terminating inflight requests.
  - Added 30-second execution deadlines/timeouts and streamed response body capping (rejecting payloads over 10 MiB) to prevent browser memory exhaustion.
- **Environment OCC Side-by-Side Conflict Resolution**:
  - Added interactive `EnvironmentOccModal` triggered upon HTTP 409 conflicts, displaying remote server version versus local draft side-by-side.
  - Enables users to pull remote truth or resubmit the local draft using the server's latest version.
- **Revisioned Storage Snapshots & Multi-Window Sync**:
  - Implemented `StorageSnapshotEnvelope` with monotonically increasing revisions, timestamps, writer IDs, and deletion tombstones across IndexedDB and localStorage snapshots.
  - Integrated Web Locks (`navigator.locks`) to serialize commits across concurrent extension windows.
  - Added multi-window broadcast coordination showing an in-app reload banner to refresh state rather than silently overwriting active drafts.
- **Progressive Host Permission Diagnostics & Recovery**:
  - Added origin checks (`chrome.permissions.contains`) for HTTP(S) endpoints before dispatch.
  - Displays user-initiated "Request Host Permission" prompt (`chrome.permissions.request`) and origin guidance when browser site access is restricted by the user.
- **Binary Response & Blob URL Lifecycle Management**:
  - Added `blobManager.ts` to track and safely release binary object URLs (`URL.revokeObjectURL`) upon request completion, history eviction, history deletion, and offline workspace deletion.
  - Stripped transient blob URLs from persisted history records to prevent dead reference accumulation in local storage.
- **Collection Detail Retry Mechanism**:
  - Flagged partial collection download failures with a retryable state in `useApiStore.ts`, keeping access restrictions intact and rendering an explicit retry badge in the sidebar.

### Fixed
- **Item Payload Validation on All Backend Write Paths**:
  - Centralized structural item validation (`backend/core/service/item_validation.go`) across `POST /api/v1/items`, `PUT /api/v1/items/{id}`, sync push mutations, and batch imports.
  - Strictly rejects malformed arrays, null entries, non-string keys, invalid auth types, and invalid item types with sanitized, leak-free error responses.
  - Hardened extension transformer (`cloudSyncTransformer.ts`) and key-value editors against malformed legacy cloud data.
- **Atomic Item Mutations & Parent Collection Version Invalidation**:
  - Wrapped item mutations (`CreateItem`, `UpdateItem`, `SoftDeleteItem`, `BatchReorderItems`) and parent collection version bump (`version = version + 1`, `updated_at = NOW()`) inside a single PostgreSQL database transaction.
  - Enforced top-down lock acquisition order (`collections` followed by `collection_items` in deterministic ID order) to prevent deadlocks, guaranteeing multi-client cache invalidation.
- **Active Collection Invariant & Hierarchy Cycle Prevention**:
  - Enforced active collection checks across all item creation, updates, and reordering operations.
  - Added cycle detection (`isDescendantOf`), cross-collection parent prevention, and validated that item parents must be of `type: 'folder'`.
- **Recursive Subtree Soft-Delete & Atomic Collection Deletion**:
  - Soft-deleting a folder recursively tombstones all descendant subfolders and request items within the collection in a single transaction.
  - Soft-deleting a collection atomically soft-deletes all contained items without swallowing errors.
- **OCC Server Truth Synchronization**:
  - Collection OCC conflict responses (`HTTP 409`) re-fetch and return the latest server database entity in `data`, matching `API_CONTRACT.md` specifications and allowing clients to perform clean merges.
- **Delta Move Timestamp Invalidation**:
  - Moving a collection between workspaces or projects atomically updates child items' `updated_at` timestamps, allowing destination scope incremental delta pulls (`GET /api/v1/sync/pull?since=...`) to retrieve all moved items.
- **Attachment Serialization Recovery**:
  - Persisted multipart form-data and binary file attachments now store clean metadata with a `needsReselection` flag instead of serializing empty `{}` objects.
  - Blocks dispatch if an enabled file attachment requires user reselection, preventing corrupt payload transmissions.
- **Workspace & Tab Session Ownership Isolation**:
  - Inflight requests and background cloud sync pulls carry session IDs and scope checks; results returning after a workspace switch or logout are safely discarded to prevent cross-scope data contamination.
- **API Contract & Collection Parity**:
  - Synchronized `backend/openapi.yaml`, `backend/openapi.json`, `backend/API_CONTRACT.md`, and `backend/airrest_api_collection.json` with 100% schema and type parity.

---

## [1.1.3] - 2026-10-26

### Added
- **Seamless Password Change Re-authentication**:
  - Updated `ChangePasswordModal` to consume newly issued session tokens (`token`, `refresh_token`, `expires_at`) from `changeUserPassword`, immediately updating `cloudConfig` to keep the active session valid without abrupt logouts.
  - Added user-facing guidance clarifying that changing passwords signs out other active devices.
- **Global Authentication Invalidation & Re-login Event Handling**:
  - Added `airrest:auth-required` custom window event dispatching in `registerAuthEvictedCallback` upon session revocation or token eviction.
  - Wired `UserMenu` to listen for `airrest:auth-required` to prompt the login modal cleanly and dismiss any open credential modals.
  - Hardened background token refresh listener (`registerTokenRefreshCallback`) to prevent token overwrite race conditions by validating `previousRefreshToken`.
- **Granular Collection Move Permission Verification**:
  - Aligned `MoveCollectionModal` target project capability checks to strictly evaluate `collection:move` rather than `collection:write`, ensuring full parity with backend RBAC security enforcement.
- **Client-Side Payload Limits & Import Safeguards**:
  - Added hard client-side request body threshold check (4 MiB) in `fetchWithAuth` to proactively protect against gateway payload overflows (`HTTP 413 Payload Too Large`).
  - Added structural validation in `batchImportToScope`: maximum 100 collections per import, maximum 5,000 collection items, and maximum 32 folder nesting depth.
  - Implemented sequential collection-by-collection cloud import in `importLocalCollectionsToCloud` with real-time progress indicators (`Importing collection X of Y...`) and partial-failure recovery.
- **Hub Multi-Select Batch Member Addition & Assignment**:
  - Added multi-select checkbox workflows with live search, select-all/deselect-all, and chips management in AirREST Hub for adding team members and assigning project members.
  - Enhanced backend `ListProjectMembers` to automatically include parent team superadministrators as permanent project admins, with dedicated UI badges.

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
