
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

1. **Dual Changelog Synchronization**:
   - `CHANGELOG.md`: Always update for any changes across the entire repository (extension, native app, hub, backend, shared libraries).
   - `CHROMEWEBSTORE.md`: Update **ONLY** for changes affecting the browser extension (`apps/extension` and extension-facing shared modules). Strictly exclude backend, hub, or desktop-only changes.

2. **Git Commit and Tag Decision Rules**:
   - **Uncommitted Version**: If the latest version in `package.json`/`manifest.json` is still uncommitted in the working tree, append the new changes under that version's section in the changelogs.
   - **Committed Version & Tag Equality**: If the latest version has already been committed:
     - Check the latest commit against the latest Git tag.
     - **If Latest Commit == Latest Tag**: The previous release is finalized. Bump the version number (e.g., in `package.json`, `apps/extension/package.json`, `apps/extension/public/manifest.json`) and initialize a new version entry in `CHANGELOG.md` and `CHROMEWEBSTORE.md`.
     - **If Latest Commit is Ahead of Latest Tag**: There are un-tagged commits ahead of the last release tag. **Explicitly ask the user for confirmation** whether the version needs to be bumped or if the new changes should be added to the current unreleased version before updating.




