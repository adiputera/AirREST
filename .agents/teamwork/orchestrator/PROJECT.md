# Project: AirREST Complete Project Audit

## Architecture
- **Repository Pattern**: Monorepo using npm workspaces (`packages/*`, `apps/*`).
- **Applications (`apps/`)**:
  - `apps/extension`: Chrome Manifest V3 extension with isolated iframe script sandbox (`public/sandbox.html`), service worker network error listener (`public/service-worker.js`), and dual full/offline edition bundling.
  - `apps/native`: Cross-platform Tauri v2 desktop (Linux, macOS, Windows) and mobile (Android) app with QuickJS WASM worker sandbox (`quickjsRunner.ts`), strict TLS cloud transport, and native file adapters.
  - `apps/hub`: Standalone React 19 web admin dashboard for teams, projects, and RBAC management with session generation invalidation and concurrent refresh deduplication.
- **Shared Packages (`packages/`)**:
  - `packages/common` (`@airrest/common`): Core domain models, Zustand store (`useApiStore.ts`), HTTP fetcher with 10 MiB body streaming cap (`fetcher.ts`), dual-engine storage adapter with Web Locks (`storage.ts`), cloud API client (`cloudApi.ts`), and Postman/cURL converters (`postman.ts`, `curl.ts`).
- **Backend Service (`backend/`)**:
  - Go 1.26 REST service with Chi router, PostgreSQL/pgx driver, and Vercel serverless function entrypoint (`api/index.go`).
- **Specification Artifacts**:
  - `backend/openapi.yaml` (OpenAPI 3.1.0, 59 endpoints)
  - `backend/openapi.json` (OpenAPI 3.1.0, 59 endpoints)
  - `backend/API_CONTRACT.md` (Interface contracts & OCC rules)
  - `backend/airrest_api_collection.json` (Postman Collection v2.1.0)
- **Deliverables Target (`docs/`)**:
  - `docs/audits/`: Categorized audit findings (P1/P2/P3), root-cause analysis, impact, file/line references, and privacy sanitization review.
  - `docs/plans/`: Actionable remediation plan and concrete verification guide.
  - Local isolation: `docs/` is in `.gitignore`, never staged, committed, or pushed.

## Feature & Findings Inventory
Every finding and audit dimension from Survey Phase is cataloged below:
| # | Finding / Feature | Severity | Description | Target File(s) & Line(s) | Milestone | Source |
|---|---|:---:|---|---|---|---|
| 1 | P1-01: CORS Origin Filter Blocks Extension Sandboxes | P1 | `AllowedOrigins` in config omits `chrome-extension://*`, blocking extension preflight OPTIONS requests | `backend/config/config.go:97`, `backend/core/app/app.go:94-101` | M1 | Survey 3 |
| 2 | P1-02: Postman Collection 59.3% Coverage Gap & Corrupted Path | P1 | Only 24 of 59 endpoints covered, sync pull URL has query param concatenated onto path array, and registration test asserts token | `backend/airrest_api_collection.json:1080`, `128-134` | M1 | Survey 3 |
| 3 | P2-01: Environment Update OCC Bypass | P2 | `if baseVersion <= 0 { baseVersion = existing.Version }` silently bypasses OCC concurrency check when `base_version` is omitted | `backend/core/service/environment_service.go:191-193` | M1 | Survey 3 |
| 4 | P2-02: PostgreSQL Error Disclosure | P2 | Raw PostgreSQL driver `err.Error()` is concatenated into HTTP 500 error messages, leaking DB hostnames/internals | `backend/core/middleware/auth.go:55`, `backend/core/handler/admin_handler.go:173` | M1 | Survey 3 |
| 5 | P2-03: Unversioned Cold-Start SQL Migrations | P2 | All 8 SQL migrations executed on every connection pool initialization without tracking table | `backend/core/repository/postgres/db.go:78-105` | M1 | Survey 3 |
| 6 | APP-01: ESLint Globally Ignores Extension Public JS | P2 | `eslint.config.mjs` ignores `**/public/**`, skipping static analysis for `service-worker.js` and `sandbox.html` | `eslint.config.mjs:10`, `apps/extension/public/` | M1 | Survey 1 |
| 7 | SCRIPT-01: Version Bumper Omits README & Postman | P2 | `bump-desktop-version.mjs` updates package manifests but omits README badge and Postman export metadata | `scripts/bump-desktop-version.mjs:40-73` | M1 | Survey 2 |
| 8 | P3-01: Backend Handler Unit Test Gaps | P3 | 7 of 10 HTTP handlers have zero unit test files; integration tests skip without live PostgreSQL | `backend/core/handler/*_test.go` | M1 | Survey 3 |
| 9 | APP-02: Undeclared `VITE_AIRREST_EDITION` in Types | P3 | Variable used in `main.tsx` and injected by Vite, but missing from `ImportMetaEnv` interface | `apps/extension/src/vite-env.d.ts:3-5` | M1 | Survey 1 |
| 10 | APP-03: Empty `pubkey` in Tauri Config Without Build Docs | P3 | Empty updater `pubkey` in config causes silent runtime warning unless compile env var set | `apps/native/src-tauri/tauri.conf.json:43`, `src-tauri/src/lib.rs:12` | M1 | Survey 1 |
| 11 | APP-04: Version Bumper Omits `apps/hub` | P3 | `bump-desktop-version.mjs` does not update `apps/hub/package.json` | `scripts/bump-desktop-version.mjs:40-73`, `apps/hub/package.json:3` | M1 | Survey 1 |
| 12 | APP-05: Sandbox Origin Development Filter Hardening | P3 | `sandbox.html` allows `localhost` / `127.0.0.1` origins without production build guard | `apps/extension/public/sandbox.html:13` | M1 | Survey 1 |
| 13 | BADGE-01: Version Badge Drift in README | P3 | README badge displays `1.3.0` while manifests and CHANGELOG are at `1.3.1` | `README.md:10` | M1 | Survey 2 |
| 14 | POSTMAN-01: Hardcoded Postman Export Version Drift | P3 | `postman.ts` hardcodes exported metadata `_postman_exported_using: 'AirREST/1.1.2'` | `packages/common/src/lib/postman.ts:1212` | M1 | Survey 2 |
| 15 | HUB-01: Hub Missing Shared Common Dependency | P3 | `apps/hub` does not import `@airrest/common`, duplicating models | `apps/hub/package.json:12-17` | M1 | Survey 2 |
| 16 | CI-01: Missing PR / Push Quality CI Workflow | P3 | Workflows only trigger on release tags or manual dispatch; no automatic PR lint/typecheck/test CI | `.github/workflows/` | M1 | Survey 2 |
| 17 | PRIVACY-01: Privacy Sanitization & Neutral Branding Review | INFO | Verified 0 corporate mentions, RFC 2606 generic demo domains, neutral branding throughout | Repository-wide | M1 | Survey 1, 2, 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Audit Deliverables Creation | Author master findings document (`docs/audits/PROJECT_AUDIT.md`), remediation plan (`docs/plans/REMEDIATION_PLAN.md`), and verification guide (`docs/plans/VERIFICATION_GUIDE.md`) | Survey Phase | DONE |
| M2 | Review & Challenger Gate | Independent review by 2 Reviewers and 2 Challengers for accuracy, line references, and test commands | M1 | DONE |
| M3 | Forensic Audit & Final Gate | Independent forensic audit by `teamwork_auditor` verifying integrity, zero cheating, and strict local docs isolation | M2 | DONE |

## Interface Contracts
- **Documentation Deliverables Structure (`AGENTS.md` & Requirements)**:
  1. `docs/audits/PROJECT_AUDIT.md`:
     - Executive summary & scope boundaries.
     - Categorized findings with priority/severity levels (`P1`/`P2`/`P3`).
     - For each finding: Title, Priority, Category, Target File(s) & Line(s), Root Cause Analysis, Impact, and Proposed Remediation.
     - Security scan details: vulnerability analysis, permission boundaries, and privacy sanitization review (verifying zero corporate mentions, generic sample data, and neutral branding per `AGENTS.md`).
     - Code quality & reliability review: error handling, concurrency, memory management, and test coverage across `apps/`, `backend/`, and `packages/`.
     - API contract synchronization review: verification across backend routes, `openapi.yaml`, `openapi.json`, `API_CONTRACT.md`, and `airrest_api_collection.json`.
  2. `docs/plans/REMEDIATION_PLAN.md`:
     - Actionable, step-by-step work packages for each finding (`P1-01`, `P1-02`, `P2-01`, `P2-02`, `P2-03`, `APP-01`, `SCRIPT-01`, `P3-01`, `APP-02`, `APP-03`, `APP-04`, `APP-05`, `BADGE-01`, `POSTMAN-01`, `HUB-01`, `CI-01`).
     - Checklist format detailing exact code diffs and migration steps without breaking existing API contracts.
  3. `docs/plans/VERIFICATION_GUIDE.md`:
     - Concrete test matrix with automated test scenarios and expected assertions.
     - Target test files for each component.
     - Exact CLI verification commands (Node.js test runners, Go tests, typecheck, lint, cURL).
     - Manual verification steps.

## Code Layout & Isolation
- **Exclusive Write Ownership**:
  - Worker 1 owns: `docs/audits/` and `docs/plans/`.
  - NO OTHER CODEBASE FILES MAY BE TOUCHED.
  - `docs/` MUST NOT BE STAGED, COMMITTED, OR PUSHED TO GIT.
  - `.gitignore` MUST NOT BE MODIFIED.
