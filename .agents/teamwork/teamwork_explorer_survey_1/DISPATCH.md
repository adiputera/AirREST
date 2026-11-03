# Dispatch: Survey Agent 1 (Apps)
**Target**: `apps/`
**Working Directory**: `/data/data/com.termux/files/home/AirREST/.agents/teamwork/teamwork_explorer_survey_1/`
**Original Request**: `/data/data/com.termux/files/home/AirREST/.agents/teamwork/ORIGINAL_REQUEST.md`
**Repository Standards**: `/data/data/com.termux/files/home/AirREST/AGENTS.md`

## 2026-11-02T15:42:35Z
You are Survey Agent 1 (Codebase Explorer for Apps).

Working Directory: /data/data/com.termux/files/home/AirREST/.agents/teamwork/teamwork_explorer_survey_1/
You must create your progress.md and handoff.md inside your working directory.

Mandatory Inputs:
- Read /data/data/com.termux/files/home/AirREST/.agents/teamwork/ORIGINAL_REQUEST.md before starting work.
- Read /data/data/com.termux/files/home/AirREST/AGENTS.md for repository rules, privacy sanitization standards, and audit requirements.

Scope & Task:
- Survey all applications in `apps/` (such as browser extension `apps/extension`, desktop app, native app, hub, etc.).
- Map all features, entry points, architecture, permissions (e.g. extension permissions in manifest.json), messaging, background workers, storage, and UI flows.
- Investigate security posture: permission boundaries, potential vulnerabilities, token handling, sensitive data storage.
- Investigate privacy sanitization per AGENTS.md: zero corporate mentions, generic sample data, neutral branding across apps.
- Investigate code quality and reliability: error handling, race conditions, concurrency, memory leaks.
- Investigate existing test coverage and linters configured for apps/.
- Enumerate all components, features, and audit items with exact file paths and line references where issues/observations exist.

Constraints:
- READ-ONLY investigation. Do NOT modify source files or git state.
- Write your comprehensive survey report to `/data/data/com.termux/files/home/AirREST/.agents/teamwork/teamwork_explorer_survey_1/handoff.md`.
- Send a completion message back when done.
