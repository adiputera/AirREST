# Changelog

All notable changes to AirREST will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
