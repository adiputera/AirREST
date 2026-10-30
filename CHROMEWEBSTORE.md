# Chrome Web Store Listings — AirREST

> Last Updated: 2026-10-30

> Chrome Web Store release notes describe browser-extension changes only. Do not include backend, Hub, or desktop release notes here.

This document provides complete, copy-paste ready store listing metadata and privacy disclosures for both editions of AirREST:
1. **Full Edition** (`npm run build:full` → `dist/`) — Online & Offline with optional cloud workspace sync.
2. **Offline Edition** (`npm run build:offline` → `dist-offline/`) — 100% Offline & Local-only with zero cloud features.

---

# 1. Full Edition (Online & Offline)

### Store Listing

**Extension Name** [REQUIRED]
```text
AirREST - REST Client
```

**Short Description** [REQUIRED] (130 / 132 chars)
```text
Fast browser-based API client with Postman collection compatibility, offline mode, optional cloud sync, and zero CORS restrictions.
```

**Detailed Description** [REQUIRED]
```text
AirREST is a fast, lightweight, and modern in-browser REST API testing client designed for developers who want to test endpoints without leaving Google Chrome.

KEY FEATURES
• Direct in-browser HTTP and HTTPS request dispatching with zero CORS limitations
• Dual storage mode: 100% offline local workspace storage or optional self-hosted cloud team synchronization
• Multi-workspace isolation: Multiple offline workspaces and online personal/team cloud workspaces
• Supports all standard HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS
• Native import and export compatibility with Postman Collection v2.1.0 and Environment files
• Multi-tab workspace with in-memory response persistence, zero-tabs empty studio state, unsaved change indicators, tab duplication, and keyboard shortcuts
• Comprehensive request body support: JSON (with beautifier & syntax check), GraphQL (query & variables), XML, URL-encoded, Form-Data (file uploads), and raw binary
• Parameter and header editors with dynamic variable interpolation ({{$guid}}, {{$timestamp}}, custom variables)
• Sandboxed scripting engine supporting pre-request scripts and post-response test assertions
• Response viewer with syntax highlighting, header inspection, timing metrics, and image/binary previews

HOW TO USE
1. Click the AirREST icon in your browser extensions toolbar to open the workspace.
2. Enter your target request URL, select an HTTP method, and configure headers, parameters, or body payloads.
3. Click "Send" or press Ctrl+Enter (Cmd+Enter on macOS) to dispatch the request.
4. Inspect the formatted response status, response time, headers, and payload.
5. Organize your requests into nested collections and environments for repeatable testing.
6. (Optional) Connect to your self-hosted AirREST backend to sync workspaces with your team.

PRIVACY & SECURITY
AirREST prioritizes developer privacy. All collections, environments, and histories are stored directly in your browser. API requests are dispatched directly from your browser to your specified target server without third-party proxies, ensuring your tokens, keys, and confidential payloads remain secure and private.

SELF-HOSTED CLOUD SYNC
The optional cloud synchronization backend (Go backend and AirREST Hub portal) is completely self-hosted and open source. The extension publisher does not provide a public cloud service, host a central database, or collect user credentials. You maintain 100% ownership and control over your data by deploying your own instance using the source code and instructions provided in the GitHub repository.

PERMISSIONS
• Access all websites ("host_permissions"): Needed to send API requests to any endpoint you configure (including localhost and private network servers) and connect to your chosen self-hosted sync server without CORS restrictions.
• Local database quota ("unlimitedStorage"): Needed to store your collections, environments, settings, and request history locally in IndexedDB without quota limitation errors.
• Network diagnostics ("webRequest"): Needed strictly as an observational listener to capture low-level network failure codes (e.g., ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, ERR_CERT_AUTHORITY_INVALID) for accurate diagnostic feedback when local servers are offline or certificates fail. It does not block or modify requests.

SUPPORT
For questions, bug reports, or feature suggestions, visit the project repository on GitHub:
https://github.com/adiputera/AirREST

Version 1.1.7 — Added universal sidebar collection and request search with multi-token parsing, multi-tab request isolation eliminating collisions across collections, in-memory per-tab response persistence, zero-tabs empty state studio, and collection badges in editor and tab hover tooltips.
Version 1.1.6 — Added Save As duplicate request independence, HTTP method and name duplicate collision guard with interactive conflict resolution (Save Copy / Replace), reader scope read-only enforcement, Scope Switcher personal workspaces management, resilient empty workspace cloud delta sync, team project auto-loading, and unified file picker flow.
Version 1.1.5 — Removed unused storage permission to adhere to the Chrome Web Store minimal permissions policy; all workspaces, collections, and environments persist durably in IndexedDB.
Version 1.1.4 — Added request lifecycle safeguards (pre-request aborts, cancellation, 30s timeout, 10 MiB stream caps), atomic item-collection versioning, side-by-side environment OCC conflict resolution, durable multi-window storage sync, and attachment recovery.
Version 1.1.3 — Added seamless password change re-authentication, sequential cloud collection import with real-time progress, and aligned move collection capabilities.
Version 1.1.2 — Added strict RBAC authority enforcement across project scopes, read-only UI indicators, and hardened client stability against edge-case crashes.
Version 1.1.1 — Refined dropdown & action button UI, optimized cloud sync payload streaming for serverless backends, and added resilient session eviction handling.
Version 1.1.0 — Added interactive Move Request modal, drag-and-drop tree reordering with safety guards, and 12-hour offline workspace caching.
Version 1.0.0 — Initial release with full Postman v2.1 compatibility, multi-tab workspace, direct in-browser dispatching, and sandboxed test scripts.
```

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
```text
AirREST is a browser-based REST API testing client that allows developers to compose, dispatch, and inspect HTTP/HTTPS requests using local storage, with an optional self-hosted cloud backend for team synchronization.
```

**Primary Language** [REQUIRED]
English

### Permissions Justification (Tab Praktik Privasi)

| Permission | Type | Justification |
|------------|------|---------------|
| `<all_urls>` | host_permissions | AirREST functions as an in-browser REST API client. Users need to send arbitrary HTTP and HTTPS requests to custom API endpoints of their choice—including public APIs, staging servers, and local development environments (localhost)—directly from the browser without Cross-Origin Resource Sharing (CORS) or mixed-content restrictions. It also enables connecting to user-configured self-hosted sync backends. Because the target API host depends entirely on what the user tests, access to all URLs is fundamentally required. |
| `unlimitedStorage` | permissions | The unlimitedStorage permission is necessary because users frequently import large Postman collection files containing hundreds of endpoints, comprehensive schemas, and heavy test scripts, as well as accumulate extensive API execution histories and response logs. It ensures that IndexedDB is not constrained by standard browser origin eviction quotas or storage limits. |
| `webRequest` | permissions | The webRequest permission is used strictly as an observational listener (`chrome.webRequest.onErrorOccurred`) to capture low-level network failure codes (e.g., `ERR_CONNECTION_REFUSED`, `ERR_NAME_NOT_RESOLVED`, `ERR_CERT_AUTHORITY_INVALID`) so developers receive accurate diagnostic feedback when local servers are offline or certificates fail. It does not block or modify requests. |

### Privacy & Data Use (Tab Praktik Privasi)
- **Remotely Hosted Code (Kode jarak jauh)**: Tidak (No)
- **User Data Collection (Pengumpulan data)**: Tidak (No)
- **Data Use Certification**: Check all 3 checkboxes (Not sold, Not used for unrelated purposes, Not used for credit/lending).

---

# 2. Offline Edition (100% Offline & Local-Only)

### Store Listing

**Extension Name** [REQUIRED]
```text
AirREST - Offline REST Client
```

**Short Description** [REQUIRED] (120 / 132 chars)
```text
Privacy-friendly, 100% offline browser-based API client with Postman collection compatibility and zero CORS restrictions.
```

**Detailed Description** [REQUIRED]
```text
AirREST Offline is a 100% offline, privacy-first in-browser REST API testing client designed for developers who want complete local isolation with zero cloud dependencies.

KEY FEATURES
• 100% offline and standalone: No accounts, no telemetry, no cloud sync, and zero external tracking
• Direct in-browser HTTP and HTTPS request dispatching with zero CORS limitations
• Multi-workspace isolation: Multiple offline workspaces with isolated tabs, history, and environments
• All collections, environments, and history stay strictly on your local computer
• Supports all standard HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS
• Native import and export compatibility with Postman Collection v2.1.0 and Environment files
• Multi-tab workspace with in-memory response persistence, zero-tabs empty studio state, unsaved change tracking and keyboard shortcuts
• Comprehensive request body support: JSON (with beautifier & syntax check), GraphQL, XML, URL-encoded, Form-Data (file uploads), and raw binary
• Parameter and header editors with dynamic variable interpolation ({{$guid}}, {{$timestamp}}, custom variables)
• Sandboxed scripting engine supporting pre-request scripts and post-response test assertions
• Response viewer with syntax highlighting, header inspection, timing metrics, and image/binary previews

HOW TO USE
1. Click the AirREST icon in your browser extensions toolbar to open the workspace.
2. Enter your target request URL, select an HTTP method, and configure headers, parameters, or body payloads.
3. Click "Send" or press Ctrl+Enter (Cmd+Enter on macOS) to dispatch the request.
4. Inspect the formatted response status, response time, headers, and payload.
5. Organize your requests into nested collections and environments for repeatable testing.

PRIVACY & SECURITY
AirREST Offline operates entirely on your device. It contains no external analytics, no cloud backends, and no third-party servers. Requests are sent directly from your browser to your specified target servers (such as localhost or private APIs) without proxies, ensuring absolute confidentiality for your credentials and data.

PERMISSIONS
• Access all websites ("host_permissions"): Needed solely to send API requests to any endpoint you configure (including localhost and private network servers) directly from the browser without CORS restrictions. The extension never contacts any developer servers.
• Local database quota ("unlimitedStorage"): Needed to store your collections, environments, settings, and request history locally in IndexedDB without quota limitation errors.
• Network diagnostics ("webRequest"): Needed strictly as an observational listener to capture low-level network failure codes (e.g., ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, ERR_CERT_AUTHORITY_INVALID) for accurate diagnostic feedback when local servers are offline or certificates fail. It does not block or modify requests.

SUPPORT
For questions, bug reports, or feature suggestions, visit the project repository on GitHub:
https://github.com/adiputera/AirREST

Version 1.1.7 — Added universal sidebar collection and request search with multi-token parsing, multi-tab request isolation eliminating collisions across collections, in-memory per-tab response persistence, zero-tabs empty state studio, and collection badges in editor and tab hover tooltips.
Version 1.1.6 — Added Save As duplicate request independence, HTTP method and name duplicate collision guard with interactive conflict resolution (Save Copy / Replace), Scope Switcher offline workspace navigation, unified native and browser file picker flows, and enhanced local collection management.
Version 1.1.5 — Removed unused storage permission to adhere to the Chrome Web Store minimal permissions policy; local collections and history persist durably in IndexedDB.
Version 1.1.4 — Added request lifecycle safeguards (pre-request aborts, cancellation, 30s timeout, 10 MiB stream caps), attachment recovery, multi-window storage synchronization, and isolated memory cleanup.
Version 1.1.3 — Client performance stability improvements, enhanced offline collection safeguards, and hardened memory management.
Version 1.1.2 — Hardened client stability against edge-case crashes, improved base64 JWT decoding, and safeguarded form-data file handling.
Version 1.1.1 — Refined dropdown & action button UI, improved header controls, and enhanced offline workspace switching.
Version 1.1.0 — Added interactive Move Request modal, drag-and-drop tree reordering with safety guards, and 12-hour offline workspace caching.
Version 1.0.0 — Initial offline release with 100% local storage, full Postman v2.1 compatibility, multi-tab workspace, direct in-browser dispatching, and sandboxed test scripts.
```

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
```text
AirREST Offline is a standalone browser-based API client that allows developers to test HTTP/HTTPS endpoints and manage Postman collections strictly locally without external cloud sync.
```

**Primary Language** [REQUIRED]
English

### Permissions Justification (Tab Praktik Privasi)

| Permission | Type | Justification |
|------------|------|---------------|
| `<all_urls>` | host_permissions | AirREST Offline functions as a standalone in-browser REST API client. Users need to send arbitrary HTTP and HTTPS requests to custom API endpoints of their choice—including public APIs, staging servers, and local development environments (localhost)—directly from the browser without Cross-Origin Resource Sharing (CORS) or mixed-content restrictions. The extension never communicates with any developer servers; access to all URLs is used solely to execute user-initiated API tests. |
| `unlimitedStorage` | permissions | The unlimitedStorage permission is necessary because users frequently import large Postman collection files containing hundreds of endpoints, comprehensive schemas, and heavy test scripts, as well as accumulate extensive API execution histories and response logs. It ensures that IndexedDB is not constrained by standard browser origin eviction quotas or storage limits. |
| `webRequest` | permissions | The webRequest permission is used strictly as an observational listener (`chrome.webRequest.onErrorOccurred`) to capture low-level network failure codes (e.g., `ERR_CONNECTION_REFUSED`, `ERR_NAME_NOT_RESOLVED`, `ERR_CERT_AUTHORITY_INVALID`) so developers receive accurate diagnostic feedback when local servers are offline or certificates fail. It does not block or modify requests. |

### Privacy & Data Use (Tab Praktik Privasi)
- **Remotely Hosted Code (Kode jarak jauh)**: Tidak (No)
- **User Data Collection (Pengumpulan data)**: Tidak (No)
- **Data Use Certification**: Check all 3 checkboxes (Not sold, Not used for unrelated purposes, Not used for credit/lending).
