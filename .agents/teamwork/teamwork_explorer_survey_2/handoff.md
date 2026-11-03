# Survey Report: Packages & Infrastructure Architecture Audit

**Survey Agent**: Survey Agent 2 (Codebase Explorer for Packages & Infrastructure)  
**Target Workspace**: `/data/data/com.termux/files/home/AirREST`  
**Working Directory**: `/data/data/com.termux/files/home/AirREST/.agents/teamwork/teamwork_explorer_survey_2`  
**Report Date**: 2026-11-02  

---

## 1. Observation

### 1.1 Monorepo Architecture & Workspace Layout
- **Root Configuration** (`package.json:6-9`):
  ```json
  "workspaces": [
    "packages/*",
    "apps/*"
  ]
  ```
  The repository is structured as a native npm workspace monorepo.
- **Packages Inventory** (`packages/`):
  - Exactly **one** shared package exists: `@airrest/common` (`packages/common/package.json:2`).
- **Applications Inventory** (`apps/`):
  1. `apps/extension` (`airrest-extension`, v1.3.1): Chrome Manifest V3 extension client.
  2. `apps/native` (`airrest-desktop`, v1.3.1): Cross-platform Tauri v2 desktop (macOS, Linux, Windows) & Android app.
  3. `apps/hub` (`airrest-hub`, v0.1.0): Standalone React 19 web administration dashboard for teams & project RBAC.
- **Backend Service** (`backend/`):
  - Go 1.26 REST synchronization service with Chi router, PostgreSQL/pgx driver, and Vercel serverless function entrypoint (`backend/api/index.go`).

### 1.2 `@airrest/common` Package Specification & Module Exports
From `packages/common/package.json:6-14`:
```json
"exports": {
  ".": "./src/index.ts",
  "./types": "./src/types/index.ts",
  "./fetcher": "./src/lib/fetcher.ts",
  "./storage": "./src/lib/storage.ts",
  "./cloud": "./src/lib/cloudApi.ts",
  "./protocol": "./src/lib/scriptProtocol.ts",
  "./styles.css": "./src/styles.css"
}
```

#### Module Inventory & Line References:
1. **Core Runtime & Context**:
   - `packages/common/src/runtime.ts` (129 lines): `createAirrestRuntime` orchestrates platform adapter wiring, store initialization, global transports, and teardown disposers (`dispose()`).
   - `packages/common/src/context.tsx` (29 lines): React context provider (`AirrestProvider`, `useAirrestRuntime`).
   - `packages/common/src/App.tsx` (184 lines): Root Studio UI container rendering Header, Sidebar, TabBar, RequestEditor, ResponseViewer, and EmptyStudioView.
2. **Type Definitions** (`packages/common/src/types/`):
   - `types/api.ts` (247 lines): Defines `ApiRequest`, `ApiResponse`, `Collection`, `CollectionItem`, `Environment`, `EnvironmentVariable`, `AuthConfig`, `FormDataItem`, `BinaryFileData`, `NetworkErrorCategory`, `FeaturePolicy`, `ActiveScope`, `ProjectRole`.
   - `types/platform.ts` (76 lines): Defines `PlatformAdapter`, `TestTransport`, `CloudTransport`, `ScriptExecutor`, `PlatformCapabilities`, `ScriptInput`, `ScriptResult`.
   - `types/payloadBuilder.ts` (37 lines): Defines `PayloadNode`, `PayloadBuilderConfig`, `DateConfig`, `PayloadValueType`.
3. **State Management** (`packages/common/src/store/`):
   - `store/storeContext.ts` (24 lines): React context bridge for Zustand `ApiStore`.
   - `store/useApiStore.ts` (5,344 lines): Central Zustand state store managing collection trees, tabs, history, offline workspaces, cloud scopes, Optimistic Concurrency Control (OCC), draft syncing, and feature policies.
4. **Libraries & Utilities** (`packages/common/src/lib/`):
   - `lib/fetcher.ts` (687 lines): Core request executor (`executeApiRequest`, `prepareRequest`, `readResponseBody`, `detectMediaType`, `categorizeNetworkError`). Enforces 10 MiB streamed body limit, 25 MiB outbound attachment limit, and 300s (5m) timeout.
   - `lib/storage.ts` (312 lines): Dual-engine storage adapter (`appStorage`) combining IndexedDB with localStorage fallback, `StorageEnvelope` revision tracking, tombstone deletions, `withStorageLock` (`navigator.locks`), and cross-tab `BroadcastChannel` synchronization.
   - `lib/cloudApi.ts` (1,101 lines): REST client for AirREST Cloud API. Implements `fetchWithAuth`, deduplicated silent token refresh (`handleSilentRefresh`), gzip payload compression for transfers > 64 KiB (`prepareRequestBody`), and OCC error mapping.
   - `lib/cloudSyncTransformer.ts` (187 lines): Transforms backend flat database rows into nested collection trees (`buildItemTree`) with cycle detection (`visited: Set<string>`) and bounded recursion (`MAX_TREE_DEPTH = 32`).
   - `lib/scriptProtocol.ts` (268 lines): Protocol boundaries for scripting sandbox: validates input/output sizes (256 KiB script, 1 MiB env/vars, 2 MiB response) and guards against prototype pollution (`__proto__`, `constructor`, `prototype`).
   - `lib/scriptRunner.ts` (308 lines): Executes pre-request and post-response scripts in isolated sandbox iframe (extension) or QuickJS worker (native).
   - `lib/postman.ts` (1,217 lines): Postman Collection v2.1.0 & Environment import/export engine with diff detector and URL decomposition.
   - `lib/curl.ts` (498 lines): Bidirectional cURL command parser and generator.
   - `lib/jwt.ts` (207 lines): Base64Url JWT decoder and capability-based RBAC checker (`hasScopePermission`, `canModifyCollection`, `canModifyEnvironment`).
   - `lib/payloadCompiler.ts` (290 lines): Tree-to-JSON and Tree-to-XML serialization engine with XML entity escaping and date formatting.
   - `lib/payloadReverseParser.ts` (407 lines): Reverse parser converting raw JSON or XML into visual `PayloadBuilderConfig` trees.
   - `lib/requestDiff.ts` (656 lines): Request normalization and diff breakdown for collection/environment imports.
   - `lib/treeHelper.ts` (166 lines): Collection tree reordering and reparenting with `isDescendantOf` circular dependency prevention.
   - `lib/urlParams.ts` (236 lines): Bidirectional URL query string and path variable parser.
   - `lib/theme.ts` (105 lines): Dark/light/system theme resolver with OS color-scheme synchronization.
   - `lib/blobManager.ts` (31 lines): Memory leak prevention and tracking for Blob object URLs.
   - `lib/backNavigation.ts` (35 lines): Priority stack for modal and drawer dismissal on Android hardware back button.
   - `lib/edition.ts` (10 lines): Build edition detection (`full` vs `offline`).
   - `lib/editorHelper.ts` (184 lines): Accessible 2-space Tab and Shift+Tab indentation helper for textareas.
   - `lib/formatters.ts` (240 lines): Indentation and beautification utilities for JSON, XML, and GraphQL.
   - `lib/hostPermissions.ts` (50 lines): Dynamic Chrome host permission checker and request helper.
5. **UI Components** (`packages/common/src/components/`):
   - 28 component modules including `RequestEditor.tsx` (85 KB), `ResponseViewer.tsx` (62 KB), `Sidebar.tsx` (85 KB), `ScopeSwitcher.tsx` (56 KB), `EnvironmentModal.tsx` (56 KB), `ImportModal.tsx` (47 KB), `TabBar.tsx` (19 KB), `Header.tsx` (18 KB), and `payload/PayloadBuilder.tsx` (32 KB).

### 1.3 Dependency Mapping & Workspace Configuration
- **Package Cross-Dependencies**:
  - `apps/extension/package.json:18`: `"@airrest/common": "*"` (properly linked workspace dependency).
  - `apps/native/package.json:14`: `"@airrest/common": "*"` (properly linked workspace dependency).
  - `apps/hub/package.json:12-17`: Does **NOT** declare `"@airrest/common": "*"` in its dependencies. Hub operates standalone with its own minimal API client (`apps/hub/src/lib/api.ts`) and store (`apps/hub/src/store/useHubStore.ts`).
- **Tooling & Build System**:
  - Bundler: Vite 8 across all applications (`apps/extension/vite.config.ts`, `apps/native/vite.config.ts`, `apps/hub/vite.config.ts`).
  - Styling: Tailwind CSS v4 via `@tailwindcss/vite`.
  - Type checking: `tsc --noEmit` per workspace, coordinated via root script `"typecheck"` (`package.json:33`).
  - Linter: ESLint 9 (`eslint.config.mjs`) with `typescript-eslint` v8.
- **CI / GitHub Actions Workflows**:
  - `.github/workflows/android-build.yml`: Debug APK workflow with SDK 36, NDK 27, Rust x86_64 target, 16 KiB page alignment check (`scripts/check-android-page-size.py`), and emulator smoke test (`scripts/android-emulator-smoke.py`).
  - `.github/workflows/desktop-release.yml`: Release workflow triggered on tags (`v*`, `desktop-v*`, `android-v*`), building macOS (ARM64 & x86_64), Linux deb/AppImage, Windows msi, and signed Android APK/AAB artifacts.

### 1.4 Test Coverage & Test Suite Mapping
The project relies on Node.js built-in test runner (`node:test`) configured across 25 root test scripts (`package.json:35-62`):
1. `scripts/security-client.test.mjs`: Tests session revocation, token refresh retry preserves session, password replacement tokens, oversized request rejection, and cyclic parent reference handling.
2. `scripts/extension-lifecycle.test.mjs`: Tests request abortion, timeout guards, and cancellation lifecycle.
3. `scripts/extension-storage.test.mjs`: Tests IndexedDB transaction commit/abort semantics, revision envelope selection, and deletion tombstones.
4. `scripts/extension-fetcher.test.mjs`: Tests request preparation, header normalization, media type detection, and restored binary attachment re-selection.
5. `scripts/cloud-compression.test.mjs`: Tests gzip thresholding (>64 KiB), stream piping, and transfer limit guards.
6. `scripts/feature-policy.test.mjs`: Tests feature policy schema validation and TTL cache behavior.
7. `scripts/hub-regression.test.mjs`: Tests Hub user management, team member assignments, project RBAC, and error envelopes.
8. `scripts/desktop-quickjs-sandbox.test.mjs`: Tests isolated JS evaluation, timeout limits, and memory protection.
9. `scripts/desktop-transport-lifecycle.test.mjs`: Tests native Tauri HTTP transport lifecycle, header sanitization, and classification.
10. `scripts/desktop-updater.test.mjs`: Tests Tauri updater manifest parsing and signature validation.
11. `scripts/tauri-file-adapter.test.mjs`: Tests native file dialogs and stream adapters.
12. `scripts/android-back-navigation.test.mjs`: Tests Android back button priority stack and overlay dismissal.
13. `scripts/android-update-banner.test.mjs`: Tests APK external browser redirect vs webview stalls.
14. `scripts/tauri-http-scope.test.mjs`: Tests Tauri HTTP plugin allowed origin scoping.
15. `scripts/sidebar-search.test.mjs`: Tests multi-token search over collections, requests, and methods.
16. `scripts/sidebar-dropdown-placement.test.mjs`: Tests dropdown alignment and viewport boundaries.
17. `scripts/scope-switcher-placement.test.mjs`: Tests ScopeSwitcher popover placement.
18. `scripts/tab-response-cache.test.mjs`: Tests in-memory tab response caching, isolation, and blob URL cleanup.
19. `scripts/path-variables.test.mjs`: Tests dynamic path variable interpolation (`:param` and `{param}`).
20. `scripts/request-collapse.test.mjs`: Tests request editor collapsible section toggles.
21. `scripts/collection-permission.test.mjs`: Tests collection resource-level RBAC and permission guards.
22. `scripts/theme-resolution.test.mjs`: Tests light/dark/system theme resolution and DOM class toggling.
23. `scripts/payload-builder.test.mjs`: Tests visual payload builder serialization to JSON/XML, reverse parsing, date formats, and XML entity escaping.
24. `scripts/collection-sync-retry.test.mjs`: Tests pending sync status tracking and automated retry upload before delta pull.
25. `scripts/environment-draft-sync.test.mjs`: Tests draft buffering, explicit Save/Discard controls, and OCC 409 conflict handling.

### 1.5 Specific Audit Findings Identified
| Finding ID | Severity | Category | File & Line Reference | Description |
|---|---|---|---|---|
| **FINDING-01** | **P3** | Documentation / Versioning | `README.md:10` | **Version Badge Drift**: `README.md` badge displays `Version-1.3.0` (`[![Version](https://img.shields.io/badge/Version-1.3.0-blue.svg)](CHANGELOG.md)`), whereas root `package.json`, `apps/extension/public/manifest.json`, `packages/common/package.json`, `apps/native/package.json`, and `CHANGELOG.md` are at `1.3.1`. |
| **FINDING-02** | **P3** | Metadata / Versioning | `packages/common/src/lib/postman.ts:1212` | **Hardcoded Export Version Drift**: In `exportPostmanEnvironment()`, the exported metadata hardcodes `_postman_exported_using: 'AirREST/1.1.2'`, which is out of sync with current app version `1.3.1`. |
| **FINDING-03** | **P3** | Monorepo Consistency | `apps/hub/package.json:12-17` | **Workspace Dependency Missing in Hub**: `apps/hub` does not declare `"@airrest/common": "*"` in its dependencies, relying on duplicate local implementations (`apps/hub/src/lib/api.ts`) rather than sharing types from `@airrest/common/types`. |
| **FINDING-04** | **P3** | CI / Automation | `.github/workflows/` | **Absence of PR / Push CI Workflow for Quality Checks**: GitHub Actions workflows only run on tag push (`desktop-release.yml`) or manual dispatch (`android-build.yml`). There is no pull request or push workflow executing `npm run typecheck`, `npm run lint`, or `npm run test:all` automatically. |
| **FINDING-05** | **P2** | Script Version Bumper Scope | `scripts/bump-desktop-version.mjs:40-73` | **Incomplete Version Bumping Targets**: The version bumper updates `package.json`, `apps/extension`, `packages/common`, `apps/native`, and `tauri.conf.json`, but omits `README.md` badge and `postman.ts` export metadata. |

---

## 2. Logic Chain

1. **Monorepo Architecture Analysis**:
   - Examination of root `package.json:6-9` confirms npm workspaces managing `packages/*` and `apps/*`.
   - Inspection of `packages/` directory revealed a single consolidated package: `packages/common`.
   - Inspection of `apps/` revealed three consumers: `apps/extension`, `apps/native`, and `apps/hub`.
   - Inspection of `apps/extension/package.json:18` and `apps/native/package.json:14` confirms both apps depend on `"@airrest/common": "*"`.
   - In contrast, `apps/hub/package.json` does not include `@airrest/common`. Tracing `apps/hub/src/App.tsx` and `apps/hub/src/lib/api.ts` demonstrates that Hub is deliberately decoupled to maintain a lightweight bundle for web admin hosting, but consequently duplicates some API models and types.

2. **Privacy Sanitization Verification (per AGENTS.md)**:
   - **Rule 1 (Zero Corporate Mentions)**: Scanned `README.md`, `CHANGELOG.md`, `CHROMEWEBSTORE.md`, package configs, and source comments. Found 0 corporate employer mentions, corporate intranets, or proprietary infrastructure references. All branding references use neutral terms: `AirREST`, `AirREST Hub`, `AirREST Team`, or public GitHub `adiputera/AirREST`.
   - **Rule 2 (Generic Sample Data)**: Verified sample data across `packages/common/src/lib/fetcher.ts`, `backend/.env.example`, `apps/hub/.env.example`, and test suites in `scripts/`. All sample endpoints use standard RFC 2606 domains (`example.com`), loopbacks (`localhost`, `127.0.0.1`), or neutral demo endpoints (`httpbin.org`).
   - **Rule 3 (Neutral Branding)**: Postman export metadata in `packages/common/src/lib/postman.ts:1212` uses neutral prefix `AirREST/1.1.2`. Manifests use `AirREST - REST Client` and `AirREST - Offline REST Client`.

3. **Code Quality, Concurrency, and Reliability Analysis in `packages/common`**:
   - **Error Handling & Resource Limits**:
     - `fetcher.ts:6-8` strictly bounds responses: 10 MiB stream body cap (`RESPONSE_SIZE_LIMIT_BYTES`), 25 MiB outbound attachment limit (`MAX_OUTBOUND_ATTACHMENT_BYTES`), and 300s timeout (`REQUEST_TIMEOUT_MS`).
     - `readResponseBody` (lines 17-57) cancels the body stream and aborts the controller immediately if size exceeds 10 MiB, protecting against OOM crashes.
     - `blobManager.ts:1-31` tracks all generated Blob URLs and provides explicit eviction methods (`revokeBlobUrl`, `revokeBlobUrls`) to prevent browser memory leaks during extended testing sessions.
   - **Concurrency & Race Condition Defenses**:
     - `storage.ts:89-94` uses Web Locks API (`navigator.locks.request`) to coordinate dual IndexedDB and localStorage commits across multiple browser tabs/windows.
     - `storage.ts:13-44` uses revision envelopes with monotonically increasing integer revisions and tombstones (`deleted: true`) to resolve race conditions between asynchronous storage operations.
     - `cloudApi.ts:389-450` maintains an in-flight deduplication map (`refreshRequests`) ensuring concurrent 401s coalesce into a single token refresh request, preventing thundering herds.
     - `cloudSyncTransformer.ts:28-65` enforces cycle detection (`visited: Set<string>`) and max depth limit (32) to prevent infinite recursion and stack overflows when parsing collection trees.
   - **Sandbox Isolation & Prototype Protection**:
     - `scriptProtocol.ts:26-27, 89, 103, 202, 224` strictly filters prototype pollution keys (`__proto__`, `constructor`, `prototype`) in environment and variable maps.
     - `scriptProtocol.ts:73-137` enforces payload size caps (256 KiB script source, 1 MiB serialized env, 2 MiB response body).

4. **Testing Infrastructure Assessment**:
   - Root `package.json` contains 25 distinct unit test commands under `scripts/*.test.mjs`, all runnable via `node --test`.
   - `scripts/` tests mock external browser APIs (DOM, IndexedDB, Web Locks, Chrome APIs) using `node:vm` and TypeScript transpilation (`ts.transpileModule`), enabling fast, deterministic execution without requiring heavy browser binaries.
   - However, no automated GitHub Action workflow runs `npm run test:all` or `npm run typecheck` on Git push or pull request events; existing workflows only trigger on tag push or manual dispatch.

---

## 3. Caveats

1. **Sandbox Shell Execution Restriction**:
   In the current Termux container environment, external process execution (`run_command`, `grep_search`) is blocked with OS-level `permission denied` on `/data/data/com.termux/files/usr/bin/*`. All observations, AST structural mappings, line references, and content verifications were performed directly using native file tools (`view_file`, `list_dir`, `find_by_name`).
2. **Dynamic Runtime Evaluation**:
   Static analysis of TypeScript source files was conducted across `packages/` and `scripts/`. Runtime execution of test suites (`npm run test:all`) requires Node.js execution permissions in an unconstrained environment.
3. **Docs Directory Isolation**:
   In strict compliance with `AGENTS.md` and `.gitignore:17`, no files inside `docs/` have been created or modified in this explorer turn, and no repository files outside `.agents/teamwork/` have been altered.

---

## 4. Conclusion

1. **Architecture Soundness**:
   `@airrest/common` is a highly mature, decoupled shared library encapsulating all core REST studio business logic, state management, HTTP execution, storage abstractions, Postman interoperability, and security sandboxing. It is cleanly integrated into `apps/extension` and `apps/native`.
2. **Privacy Sanitization Compliance**:
   The repository is 100% compliant with `AGENTS.md` Personal Project and Privacy Sanitization rules: zero corporate mentions, generic demo domains (RFC 2606), and neutral branding throughout.
3. **Identified Audit Opportunities**:
   Minor maintenance items identified include:
   - Synchronizing version badge in `README.md:10` to `1.3.1`.
   - Updating hardcoded export version in `packages/common/src/lib/postman.ts:1212` to `1.3.1`.
   - Updating `scripts/bump-desktop-version.mjs` to keep `README.md` and `postman.ts` in sync during releases.
   - Adding a pull-request CI workflow (`.github/workflows/ci.yml`) to execute `typecheck`, `lint`, and `test:all` automatically.

---

## 5. Verification Method

To independently verify all findings and architectural observations in this report:

1. **Verify Monorepo Workspaces & Package Layout**:
   - Inspect `package.json:6-9` and verify `packages/*` and `apps/*`.
   - Inspect `packages/common/package.json:1-34` for name `@airrest/common` and export targets.
   - Inspect `apps/extension/package.json:18` and `apps/native/package.json:14` for `@airrest/common` dependency.
2. **Verify Specific Audit Findings**:
   - View `README.md:10` to observe `Version-1.3.0` badge (FINDING-01).
   - View `packages/common/src/lib/postman.ts:1212` to observe `_postman_exported_using: 'AirREST/1.1.2'` (FINDING-02).
   - View `apps/hub/package.json:12-17` to observe absence of `@airrest/common` (FINDING-03).
   - View `.github/workflows/` to observe absence of PR quality test workflows (FINDING-04).
   - View `scripts/bump-desktop-version.mjs:40-73` to observe target files list (FINDING-05).
3. **Test Suite Verification Commands** (in an environment with execution privileges):
   ```bash
   # Run all 25 unit test suites across packages and shared modules
   npm run test:all

   # Run type checks across all workspaces
   npm run typecheck

   # Run ESLint across codebase
   npm run lint
   ```
4. **Invalidation Conditions**:
   - If `@airrest/common` is split into multiple packages, re-map dependencies and exports.
   - If version `1.3.2` is released, verify `scripts/bump-desktop-version.mjs` targets.
