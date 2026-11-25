
## Personal Project & Privacy Sanitization

This repository is a **personal project**, not a corporate/company project.

1. **Zero Corporate Mentions**: Never introduce, suggest, or keep employer names, company names, internal corporate domains (e.g., private corporate intranets, `*.corp.*`, internal VPN hosts), or company-internal infrastructure names in any code, comments, sample datasets, export metadata, or documentation (`README.md`).
2. **Generic Sample Data**: Always use neutral, standard conventions for demo/sample URLs, headers, and query parameters (e.g., `https://httpbin.org/get?user=tester&tag=api`, `localhost`, RFC 2606 `example.com`, or `jsonplaceholder.typicode.com`).
3. **Neutral Branding**: In export headers, application titles, and Postman export metadata (e.g., `_postman_exported_using`), strictly use neutral project names (e.g., `AirREST`), avoiding any employer or company prefixes.

## API Contract Maintenance & Synchronization

Whenever there are modifications, additions, or deprecations to backend REST endpoints, request/response payload schemas, query parameters, authentication mechanisms, error envelopes, or role-based access controls (RBAC):

1. **Mandatory Contract Synchronization**: You MUST update all existing API contract documents to keep them in 100% sync with the backend implementation and frontend expectations:
   - `backend/openapi.yaml`: Update the OpenAPI 3.1.0 YAML specification with new/modified routes, parameters, schemas, and response envelopes.
   - `backend/openapi.json`: Re-generate or synchronize the JSON equivalent of the OpenAPI specification.
   - `backend/API_CONTRACT.md`: Update the re-implementation guide, architectural protocols, OCC rules, and frontend expected value tables.
   - `backend/airrest_api_collection.json`: Update the Postman / AirREST test collection if endpoint paths, headers, or request bodies change.
2. **Type & Value Parity**: Ensure that field names, data types (e.g., boolean vs string), and strict enum values (e.g., roles, item types, methods) match across the OpenAPI specs, markdown guide, backend code, and frontend client handlers.
3. **Syntax Validation**: Always validate the YAML/JSON syntax of `backend/openapi.yaml` and `backend/openapi.json` after making updates to ensure machine-readability.

## Mandatory Audit & Scan Documentation

Whenever asked to perform a code audit, security scan, reliability scan, or architectural review:

1. **Always Create Documentation in `docs/`**: In addition to summarizing in chat, you MUST automatically create or update structured markdown documentation in the `docs/` directory (using `docs/audits/` for findings and `docs/plans/` for remediation & verification plans, or a combined document in `docs/` if appropriate):
   - **Findings**: Categorized list of issues with severity/priority levels (`P1`/`P2`/`P3`), root-cause analysis, impact, and exact file/line references.
   - **Remediation / Fix Plan**: Actionable, step-by-step work packages and checklists detailing how to fix each finding without breaking existing contracts.
   - **Verification Guide**: Concrete test matrix (automated test scenarios, expected assertions, target test files), exact CLI verification commands, and manual verification steps.
2. **Local-Only & Strictly Ignored (`docs/`)**: The `docs/` directory is intentionally ignored in `.gitignore` and must remain strictly local:
   - **Never Stage, Commit, or Push**: NEVER add, commit, or push any files or directories inside `docs/` to Git.
   - **Never Modify `.gitignore` to Un-ignore Docs**: NEVER alter `.gitignore` to whitelist or track `docs/` (e.g., never add `!docs/*` or `!docs/*.md`). The `docs/` folder is deliberately ignored by design.

## Mandatory Changelog & Version Maintenance

Whenever changes, features, refactors, or bug fixes are made to the codebase:

1. **Unified Semantic Versioning (`MAJOR.MINOR.PATCH`)**:
   - This repository uses a **single unified version** across all apps, shared packages, native manifests, and release metadata, adhering to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) (`X.Y.Z` or `X.Y.Z-prerelease.N`, without a leading `v` in manifest files).
   - **Never bump version files manually in isolation.** Always use the official repository version-bumper script:
     ```bash
     npm run version:desktop -- <version>
     # or: npm run version:native -- <version>
     ```
   - `scripts/bump-desktop-version.mjs` atomically synchronizes all unified version targets:
     - `package.json` (root)
     - `apps/extension/package.json` & `apps/extension/public/manifest.json`
     - `apps/hub/package.json`
     - `apps/native/package.json`, `apps/native/src-tauri/tauri.conf.json`, & `apps/native/src-tauri/Cargo.toml`
     - `apps/native/src-tauri/gen/android/app/tauri.properties` (if Android is initialized; computes `tauri.android.versionCode` as `major * 1000000 + minor * 1000 + patch`)
     - `packages/common/package.json` & `packages/common/src/lib/postman.ts` (`_postman_exported_using: 'AirREST/<version>'`)
     - `README.md` (Version shield badge)
   - After running the script, keep workspace versions in `package-lock.json` synchronized (e.g., via `npm install --package-lock-only`) and verify with `npm run test:version-bumper` and `npm run test:release-notes`.

2. **Dual Changelog Synchronization**:
   - `CHANGELOG.md`: Always update for any changes across the entire repository (extension, native app, hub, backend, shared libraries) following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (`## [<version>] - YYYY-MM-DD` with `Added`, `Changed`, `Fixed`, etc.).
   - `CHROMEWEBSTORE.md`: Update **ONLY** for changes affecting the browser extension (`apps/extension` and extension-facing shared modules). Update `> Last Updated: YYYY-MM-DD` and strictly exclude backend, hub, or desktop-only changes. `CHROMEWEBSTORE.md` maintains **two separate release-note sections** for the two extension editions, so update both when applicable:
     - **Full Edition (Online & Offline)** (`npm run build:full` → `dist/`, top release-notes block under `# Chrome Web Store Listings — AirREST`): Add/append the `> <version>: ...` entry covering all extension-facing changes (both local and cloud/online features).
     - **Offline Edition (100% Offline & Local-Only)** (`npm run build:offline` → `dist-offline/`, under `# 2. Offline Edition (100% Offline & Local-Only)` → `### Release Notes`): Add/append the `> <version>: ...` entry **only** with changes that apply to the 100% offline/local-only edition; strictly exclude cloud-only or online-only features (such as cloud sync, cloud auth/accounts, or cloud project/team operations).

3. **Git Commit and Tag Decision Rules**:
   - **Uncommitted Version**: If the latest version bump in `package.json`/`apps/extension/public/manifest.json` is still uncommitted in the working tree, append the new changes under that version's section in `CHANGELOG.md` (and `CHROMEWEBSTORE.md` if extension-facing) without bumping again.
   - **Committed Version & Tag Equality**: If the latest version has already been committed:
     - Compare `HEAD` against the latest Git tag (e.g., `git describe --tags --abbrev=0` and `git rev-list <latest-tag>..HEAD --count`).
     - **If `HEAD` == Latest Tag (`0` commits ahead)**: The previous release is finalized. Bump the version number using `npm run version:desktop -- <new-version>` (choosing `PATCH` for bug fixes/refactors, `MINOR` for backward-compatible features, `MAJOR` for breaking changes) and initialize a new version entry in `CHANGELOG.md` and `CHROMEWEBSTORE.md` (if applicable).
     - **If `HEAD` is Ahead of Latest Tag (`> 0` commits ahead)**: There are un-tagged commits ahead of the last release tag (for example, when `package.json` was already bumped in an earlier un-tagged commit). **Explicitly ask the user for confirmation** whether the version needs to be bumped again or if the new changes should be added to the current unreleased version before updating.
   - **Tagging Convention**: Release tags use `v<version>` for unified releases (or `desktop-v<version>` / `android-v<version>` when triggering target-specific workflows in `.github/workflows/desktop-release.yml`, whose notes are extracted from `CHANGELOG.md` by `scripts/extract-release-notes.mjs`). Never create or push Git tags unless explicitly requested by the user.




