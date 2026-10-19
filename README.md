# AirREST

> A fast, lightweight, and modern browser-based REST API testing studio packaged as a **Google Chrome Extension (Manifest V3)** and standalone web client with optional cloud team synchronization. Built with **React 19**, **Vite**, **Tailwind CSS v4**, **Zustand**, and a **Go + PostgreSQL** cloud backend.

[![GitHub Repository](https://img.shields.io/badge/GitHub-adiputera%2Fapi--tester-181717?logo=github)](https://github.com/adiputera/api-tester)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-10B981.svg)](LICENSE)

---

## ⚡ Why AirREST?

Most web-based API testing tools are severely constrained by browser security models: CORS preflight restrictions, mixed-content blocking (refusing to send unencrypted HTTP calls from HTTPS domains), and strict private network limits. Desktop clients such as Postman or Insomnia are feature-rich but heavy, consume considerable memory, and frequently require cloud account synchronization.

**AirREST provides an agile, zero-friction alternative by running directly in your browser as a Chrome Extension (Manifest V3):**

- 🛡️ **Zero CORS & Mixed-Content Blocks**: Chrome host permissions (`<all_urls>`) allow direct, unrestricted HTTP and HTTPS dispatching from your browser.
- 💻 **Flexible Workspace Modes (Offline vs Cloud)**: Run **100% Offline** using local storage (zero tracking, instant launch), or connect to **Cloud Sync Mode** for multi-device backup and team collaboration.
- 👥 **Workspace & Project Switcher**: Unified switcher to seamlessly alternate between local **Offline Workspace** (zero cloud sync) and **Online Cloud Workspaces** (Personal & Team Projects with RBAC tags `Admin`, `Maintainer`, `Contributor`, `Reader`), featuring per-scope tab and history isolation, and state caching.
- 🔄 **Workspace & Project Collection Relocation**: Move collections seamlessly from Offline LocalStorage to Cloud Workspaces, or across projects within the same team, protected by granular RBAC (requires contributor role or above in both source and target scopes).
- 🔑 **Rolling Refresh Tokens**: 30-day rolling refresh token rotation with silent background refresh ensures active sessions are never abruptly logged out.
- 🏢 **Decoupled Management Hub (`hub/`)**: Separate full-page dashboard deployable on Vercel for managing teams, project RBAC, project collections & environments with granular role-based permissions, and user provisioning without bloating the browser extension.
- 📁 **Native Postman v2.1 Compatibility**: Import and export standard Postman Collections and Environments without vendor lock-in.

---

## 🚀 Quick Start

### 1. Build & Load the Chrome Extension Studio

AirREST uses a single codebase with multi-target compilation supporting two distinct distribution editions:

| Edition | Build Command | Output Directory | Target Distribution | Description |
|---|---|---|---|---|
| **Offline Only** | `npm run build:offline` | `extension/dist-offline/` | **Chrome Web Store (Public)** | 100% offline, privacy-focused, zero cloud auth/sync UI, minimal permissions, instant approval. |
| **Full (Cloud + Offline)** | `npm run build` | `extension/dist/` | **Unlisted / Team Collaboration** | Dual-mode: offline storage + team workspace sync, RBAC, and Hub backend integration. |
| **Both Editions** | `npm run build:all-extensions` | `extension/dist/` & `extension/dist-offline/` | All targets | Compiles both packages simultaneously with dead-code elimination. |

```bash
# Clone the repository
git clone git@github.com:adiputera/api-tester.git
cd api-tester

# Install dependencies (links both extension & hub)
npm install

# Build for Chrome Web Store (100% Offline Only)
npm run build:offline

# Or build the Full Edition (Offline + Cloud Sync)
npm run build
```
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select:
   - **`extension/dist-offline/`** to run or inspect the Chrome Web Store offline-only release.
   - **`extension/dist/`** to run or inspect the full cloud-sync edition.

### 2. Deploy AirREST Hub to Vercel (Management Portal)
AirREST Hub is located in the **`hub/`** directory and deploys to Vercel with zero configuration:
1. In the [Vercel Dashboard](https://vercel.com/dashboard), import this repository.
2. Set **Root Directory** to **`hub`**.
3. Framework Preset: **Vite**.
4. Click **Deploy**!

### 3. Run the Cloud Sync Backend (Optional)
AirREST works 100% offline out-of-the-box. For team collaboration and multi-device sync, spin up the Go backend:
```bash
cd backend

# Copy sample configuration (ensure .env is never pushed to git!)
cp .env.example .env

# Start PostgreSQL with Docker
docker compose up -d postgres

# Start the Go server
go run cmd/server/main.go
```
The server starts at `http://localhost:8080`, runs automatic database schema migrations, and bootstraps the default Superadmin account (`admin@example.com`).

---

## 🔐 Environment Variables & Security Safeguards

To maintain strict security and confidentiality, **environment variables containing sensitive credentials must never be committed or pushed to version control**.

### 1. Git Protection via `.gitignore`
The repository's `.gitignore` contains strict glob rules protecting all environment variable files:
```gitignore
# Environment variables & secrets (Never commit secrets!)
.env
.env.*
*.env
!.env.example
!.env.*.example
!*.env.example
```
- All local environment files (`.env`, `.env.local`, `.env.production`, `backend/.env`, etc.) are **strictly ignored**.
- Only sanitized example templates (`.env.example`, `backend/.env.example`) are tracked in Git as reference models.

### 2. Backend Environment Variables (`backend/.env`)

The backend reads configuration from environment variables or a local `backend/.env` file:

| Variable | Required | Default / Example | Description |
|---|---|---|---|
| `PORT` | Optional | `8080` | Port for the HTTP server to listen on. |
| `DATABASE_URL` | **Yes** | `postgres://airrest:airrest_secret_password@localhost:5432/airrest_db?sslmode=disable` | PostgreSQL connection string. For Vercel Serverless, use a pooled connection string (e.g. Neon or Supabase transaction pooler on port 6543 with `?sslmode=require`). |
| `JWT_SECRET` | **Yes** | `super-secret-jwt-key-change-in-production-minimum-32-chars` | High-entropy secret key used to sign and verify HS256 JWT tokens (minimum 32 characters). |
| `JWT_EXPIRATION_HOURS` | Optional | `72` | Lifespan in hours for access tokens. |
| `JWT_REFRESH_EXPIRATION_DAYS` | Optional | `30` | Lifespan in days for rolling refresh tokens. |
| `SUPERADMIN_EMAIL` | Optional | `admin@example.com` | Email for bootstrap Superadmin account created on first boot if no superadmin exists. |
| `SUPERADMIN_PASSWORD` | Optional | `SuperadminSecurePassword123!` | Strong password for bootstrap Superadmin account. |
| `SUPERADMIN_NAME` | Optional | `Super Administrator` | Display name for bootstrap Superadmin account. |
| `DB_MAX_CONNS` | Optional | `25` (Docker) / `4` (Vercel) | Maximum concurrent connections in `pgxpool`. |
| `DB_MIN_CONNS` | Optional | `2` (Docker) / `1` (Vercel) | Minimum idle connections in `pgxpool`. |
| `SKIP_MIGRATIONS` | Optional | `false` | Set to `true` if database migrations are handled via external CI/CD pipelines instead of on application boot. |

> [!IMPORTANT]
> **Production Deployment Safeguard**: When deploying to Vercel, Fly.io, AWS, or Docker, configure these variables directly in your host's secure environment settings dashboard. Never commit `.env` into your Git repository.

### 3. Frontend & Extension Security
- **No Bundled Secrets**: The Chrome Extension and Hub client bundles contain zero hardcoded API keys or server secrets.
- **Client-Side Secret Storage**: User credentials, JWT access tokens, and refresh tokens are stored purely in the user's isolated browser storage (Zustand persist) and sent only via standard `Authorization: Bearer <token>` headers over HTTPS/HTTP.
- **High-Capacity Persistent Storage (IndexedDB & `unlimitedStorage`)**: Workspaces, collections, environments, and histories are backed by an asynchronous IndexedDB storage layer with automatic zero-loss migration from `localStorage`. Accompanied by the extension's `unlimitedStorage` permission, this eliminates browser 5MB `localStorage` quota restrictions and effortlessly supports multi-megabyte collections (3MB+ to 50MB+).

---

## ✨ Features

### 1. 📁 Postman v2.1 Collection Import & Export
- **Two-way Interoperability**: Full support for the standard Postman Collection `v2.1.0` JSON schema.
- **Deep Hierarchy Preservation**: Preserves nested folder trees, query parameters, header tables, request bodies, and scripting hooks.
- **Flexible Import**: Import collections via drag-and-drop file upload or direct JSON text paste.
- **Duplicate Conflict Resolution**: Intelligent duplicate detection when importing collections with matching names. Provides Postman-style **"Import as Copy"** (auto-appends ` (Copy)` with fresh UUIDs) or **"Replace"** (overwrites in-place while aligning item IDs and syncing with cloud backend).
- **Request Differences Breakdown**: Visual difference inspector displaying which endpoints are `Added`, `Modified`, or `Removed` without cluttering the screen with deep raw body diffs.
- **1-Click Export**: Export any individual collection directly from the sidebar or global header to Postman v2.1 JSON to share with teammates.
- **Safe Management & Confirmations**: Deleting collections or environments triggers a modern confirmation dialog to prevent accidental data loss.
- **Real-Time Search**: Instant filtering across collection names, folders, and nested request endpoints.
- **Sample Collection**: One-click demo loader with pre-configured endpoints and assertions for quick testing.

### 2. 🌍 Environment Variables & Dynamic Templating
- **Environment Switcher**: Create and switch between environments (e.g., `Localhost`, `Development`, `Staging`, `Production`) directly from the header dropdown.
- **Postman Environment Interoperability**: Import and export Postman Environment `.json` files.
- **Duplicate Conflict Resolution**: Intelligent duplicate detection when importing environments with matching names via global Import or Environment Manager. Provides a visual variable differences breakdown (`+Added`, `~Modified`, `-Removed`, `Same`) and options to **"Import as Copy"** (auto-appends ` (Copy)` with fresh UUIDs) or **"Replace"** (updates in-place while aligning variable IDs and syncing with cloud backend).
- **Granular Environment RBAC & Protection**: Protect sensitive environments (e.g. Production) within team projects using 4-tier role-based restrictions (`All Members (Reader+)`, `Contributor+`, `Maintainer+ (Production/Release)`, or `Admin Only`). Environments restricted to higher roles are strictly filtered at the backend and never exposed to unauthorized project members, preventing privilege escalation.
- **Syntax Highlighting for Variables**: Monospace syntax highlighting for `{{variableName}}` inside request URLs, Authorization credentials, query parameters, and header tables with amber (resolved) and rose (unresolved) indicators.
- **Interactive Hover Tooltip Popups**: Hovering over any `{{variableName}}` reveals a floating inspector displaying its resolved value, current environment scope, and resolution suggestions.
- **Live Resolved URL Preview**: Real-time evaluation banner beneath the URL bar displaying the fully interpolated endpoint before dispatch.
- **Variable Interpolation**: Use `{{variableName}}` across request URLs, query parameters, custom headers, authentication credentials, and request bodies.
- **Built-in Dynamic Variables**:
  - `{{$guid}}` — Generates a random UUID v4.
  - `{{$timestamp}}` — Current Unix timestamp in seconds.
  - `{{$isoTimestamp}}` — Current ISO 8601 UTC date-time string.
  - `{{$randomInt}}` — Random integer between 1 and 1000.

### 3. 🔐 Authorization Suite & Inheritance
- **Auth Modes**:
  - **Bearer Token**: Token authentication with variable interpolation (e.g. `{{token}}`).
  - **Basic Auth**: Auto-encoded Base64 username and password (e.g. `{{username}}`, `{{password}}`).
  - **API Key**: Flexible key/value pairs configurable in either **Headers** or **Query Params**.
  - **OAuth 2.0 Compatibility**: Automatically extracts bearer tokens from imported Postman OAuth 2.0 configurations.
- **Hierarchical Inheritance**:
  - Automatically cascades collection-level and folder-level authorization rules down to nested requests.
  - Supports granular request-level overrides, `noauth`/`none` opt-outs, and legacy header fallbacks.

### 4. 💻 cURL Import & Export
- **Copy as cURL**: Click **Copy cURL** in the request bar to copy a shell-ready command formatted with active query parameters, headers, interpolated variables, and request bodies.
- **Import from cURL**: Paste any terminal or browser DevTools cURL command into the **Import** modal to instantly populate an active tab.
- Automatically parses `-X / --request`, `-u / --user`, `-H / --header`, `-d / --data`, `--json`, `--data-binary` (raw files & payloads), `-F / --form` (multipart files & text fields), `-A / --user-agent`, `-b / --cookie`, and extracts query parameters directly into the editable Params table.

### 5. 📜 Sandboxed Scripting Engine (`pm.*`)
- **Pre-request Scripts**: Execute JavaScript prior to request dispatch to compute signatures, generate timestamps, or adjust headers.
- **Tests & Post-response Scripts**: Inspect responses programmatically with `pm.response.code`, `pm.response.headers`, and `pm.response.json()`.
- **Automated Token Extraction**:
  ```javascript
  // Extract token from authentication response and save to active environment
  const res = pm.response.json();
  const token = res.token || res.access_token || res.data?.token;

  if (token) {
    pm.environment.set("token", token);
    console.log("Token stored as {{token}}");
  }
  ```
  Variables saved via `pm.environment.set()` immediately update the active environment, allowing chained requests to use `{{token}}` in auth and headers.
- **Sandboxed Security**: Script execution occurs inside an isolated Manifest V3 sandboxed iframe (`sandbox.html`).
- **Assertion Feedback**: Test assertions and variable updates are displayed directly in the response panel.

### 6. 📁 Direct Binary File & Multipart Upload
- **Direct Raw Binary Upload (`bodyType = 'binary'`)**:
  - Stream raw binary files (images, PDFs, audio, firmware, ZIP archives, or documents) directly in the HTTP request body without multipart boundaries or encoding wrappers.
  - Drag-and-drop dropzone with instant file metadata preview (file name, formatted byte size, and MIME type).
  - Automatically sets `Content-Type` to the file's native MIME type (or `application/octet-stream`), while allowing explicit overrides in the Headers tab.
  - Full two-way support in cURL (`--data-binary "@filename"`) and Postman Collection v2.1 import/export (`"mode": "file"`).
- **Multipart Form-Data (`multipart/form-data`)**:
  - Supports `form-data` with both **Text** key-value pairs and **File** attachments.
  - Integrated file selector with file name and size indicators.
  - Dispatches documents, images, and binary files with automatic boundary negotiation.
- **URL-Encoded Form Data (`x-www-form-urlencoded`)**:
  - Interactive **Key-Value Form table** (Key, Value, enable/disable checkboxes, row deletion, and variable templates `{{var}}`).
  - **Bulk Edit Mode**: 1-click toggle between interactive form rows and multi-line bulk text (`key: value` or `key=value`).
  - Intelligent conversion when switching from JSON payloads or parsing raw query strings.
  - Automatically dispatches with `Content-Type: application/x-www-form-urlencoded` with standard URL encoding.
  - Full two-way support in cURL (`--data-urlencode "key=value"`) and Postman Collection v2.1 import/export (`"mode": "urlencoded"`).

### 7. 📑 Multi-Tab Workspace & Request Builder
- Concurrent, independent request tabs with method color badges, middle-click close, and close handlers.
- **📑 Tab Context Menu & Quick Management**:
  - Right-click any tab to access **Close Tab**, **Close Other Tabs**, **Close Tabs to the Right**, **Close All Tabs**, **Duplicate Tab**, and **New Request Tab**.
  - Right-click anywhere on the empty tab bar space to quickly open a new tab or close all tabs.
  - Middle-click (<kbd>auxclick</kbd>) on any tab instantly closes it.
- Comprehensive HTTP method support: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.
- **🔄 Two-Way URL & Query Param Synchronization**:
  - Editing query parameters directly in the URL input bar (e.g. modifying `?f=webp&s=100`) immediately synchronizes and updates the rows in the **Params** key-value table.
  - Adding, editing, deleting, or unchecking parameters in the **Params** table instantly recomputes and updates the query string in the URL bar.
  - Full support for multi-value query keys, variable templates (`{{var}}`), and unchecked parameter preservation.
- **Payload Builders & Formatters**:
  - **🚀 Native GraphQL Support (`bodyType = 'graphql'`)**: Dedicated dual editor with separate panes for **Query / Mutation** and **GraphQL Variables (JSON)**. Features 1-click **Prettify Query** indentation and **Beautify Variables** validation. Automatically sets `Content-Type: application/json` and switches method to `POST`. Full two-way support in Postman Collection v2.1 (`"mode": "graphql"`) and cURL commands.
  - **First-Class XML Support (`bodyType = 'xml'`)**: Dedicated XML body mode with 1-click **Beautify XML** indentation and real-time syntax validation. Automatically sets `Content-Type: application/xml`.
  - **Raw Mode Sub-Type Selector (`text`, `json`, `xml`, `html`)**: Choose the exact payload format when using `raw` body mode. Automatically assigns appropriate `Content-Type` headers (`text/plain`, `application/json`, `application/xml`, `text/html`) unless overridden in Headers.
  - **JSON Beautifier**: 1-click **Beautify JSON** formatting with error detection.
  - Full two-way support in cURL generation/parsing and Postman Collection v2.1 import/export (`options.raw.language: "xml" | "json" | "html" | "text"`).
- Quick keyboard dispatch: <kbd>Ctrl + Enter</kbd> (Windows/Linux) or <kbd>Cmd + Enter</kbd> (macOS).
- **Save to Collection & Unsaved Changes Indicator**:
  - **Postman-style Unsaved Indicator (`●`)**: Displays a glowing indicator dot on tabs and request headers whenever a request has unsaved modifications (such as changes to URL, method, headers, parameters, body payloads, or scripts).
  - **Direct In-Place Save & Shortcut**: Pressing <kbd>Ctrl + S</kbd> / <kbd>Cmd + S</kbd> or clicking **Save** immediately saves updates in-place to the source collection item and clears the dot. For new requests, prompts the **Save to Collection** modal. **Save As** enables saving copies across collections.

### 8. 📊 Response Inspector
- Real-time HTTP status badge, round-trip latency (`ms`), and payload size.
- Inspection views:
  - **Pretty / Raw Text**: Syntax-highlighted JSON viewer with formatting and raw text inspection.
  - **🖼️ Image Response Preview**: Native rendering for image responses (`image/webp`, `image/png`, `image/jpeg`, `image/gif`, `image/svg+xml`, `image/avif`) on a transparency canvas, displaying image dimensions, full-screen opening, and direct image download.
  - **📦 Binary Non-Image File Handling**: Clean binary file status card displaying MIME type and size, with a 1-click **Download** button to download files natively without text corruption.
  - **Headers**: Structured table of returned HTTP response headers.
- Utilities for 1-click **Copy Response** and smart **Download** (automatically assigns proper extensions based on MIME type or `Content-Disposition` header).

### 9. 🕒 History & Persistent Storage
- Automatically logs dispatched requests to the **History** tab with status indicators and execution times.
- Search and filter across collections and request history.
- Persisted locally across browser sessions via Zustand Persist.

---

## 🛠 Local Development & Scripts

### Frontend & Extension Scripts (Node.js)

| Command | Description |
|---|---|
| `npm run dev` | Runs the local Vite development server for the Chrome Extension studio |
| `npm run dev:offline` | Runs the offline-only mode Vite development server |
| `npm run build` | Builds the production Chrome Extension bundle into `extension/dist/` |
| `npm run build:offline` | Builds the offline-only Chrome Extension bundle into `extension/dist-offline/` |
| `npm run build:extension` | Alias for `npm run build` |
| `npm run build:all-extensions` | Compiles both Chrome Extension editions simultaneously |
| `npm run dev:hub` | Runs the local Vite development server for AirREST Hub (`hub/`) |
| `npm run build:hub` | Builds the production AirREST Hub bundle into `hub/dist/` |
| `npm run build:all` | Compiles both Chrome Extension editions and the Hub portal |
| `npm run preview` | Previews the production extension build locally |
| `npm run typecheck` | Validates TypeScript types across both extension and hub |
| `npm run lint` | Runs ESLint validation across the repository |

### Backend Scripts (Go & Docker)

| Command | Description |
|---|---|
| `cd backend && docker compose up -d postgres` | Starts the local PostgreSQL 16 database |
| `cd backend && go run cmd/server/main.go` | Starts the standalone Go REST API service on `:8080` |
| `cd backend && go test -v ./...` | Executes the complete Go test suite |
| `cd backend && docker compose down` | Stops the local PostgreSQL database container |

---

## 📦 Project Structure

```
├── .gitignore                    # Comprehensive ignore rules (.env, binaries, dist)
├── package.json                  # Root npm workspace configuration (workspaces: ["extension", "hub"])
├── package-lock.json
├── eslint.config.mjs             # Monorepo-wide ESLint configuration
├── tsconfig.json                 # Workspace root TypeScript configuration
│
├── extension/                    # Chrome Extension (Manifest V3 + React 19 + Tailwind v4)
│   ├── dist/                     # Compiled full edition (load unpacked in chrome://extensions)
│   ├── dist-offline/             # Compiled offline-only edition
│   ├── public/                   # Static assets (manifest.json, sandbox.html, service-worker.js, icons)
│   ├── src/                      # Chrome Extension React 19 source code
│   │   ├── components/           # UI components (Header, RequestEditor, ResponseViewer, Modals)
│   │   ├── lib/                  # Utilities (cURL, fetcher, postman, scriptRunner, cloudApi)
│   │   ├── store/                # Zustand persistent application store
│   │   ├── types/                # TypeScript data models and interfaces
│   │   ├── App.tsx               # Studio layout shell
│   │   ├── index.css             # Tailwind CSS v4 styling
│   │   └── main.tsx              # React DOM entrypoint
│   ├── index.html                # Extension main window HTML
│   ├── package.json              # Extension dependencies & scripts
│   ├── tsconfig.json             # Extension TypeScript configuration
│   └── vite.config.ts            # Extension Vite bundler configuration
│
├── hub/                          # AirREST Hub management portal (Vite + React 19 + Tailwind v4)
│   ├── src/                      # Hub pages (Teams, Projects, Superadmin, Connect)
│   ├── dist/                     # Hub compiled output (ignored in git)
│   ├── package.json              # Hub dependencies
│   ├── vercel.json               # Hub Vercel routing configuration
│   └── vite.config.ts            # Hub Vite configuration
│
└── backend/                      # Go REST synchronization service (Chi + PostgreSQL + pgx)
    ├── api/                      # Vercel Serverless Function entrypoint (index.go)
    ├── cmd/server/               # Standalone server entrypoint (main.go)
    ├── config/                   # Configuration loader & environment parser
    ├── core/                     # Domain logic, handlers, middleware, repos, services
    │   ├── domain/               # Core data models (User, Team, Project, Collection, Item)
    │   ├── handler/              # HTTP REST handlers (Auth, Sync, Workspace, Admin)
    │   ├── middleware/           # JWT auth, CORS, and logging middleware
    │   ├── repository/           # PostgreSQL pgx queries & embedded SQL migrations
    │   └── service/              # Business logic & Optimistic Concurrency Control (OCC)
    ├── pkg/                      # Shared packages (hasher, response, token)
    ├── .env.example              # Sanitized template for backend environment variables
    ├── .gitignore                # Backend-specific ignore rules
    ├── docker-compose.yml        # PostgreSQL container setup
    ├── Dockerfile                # Production container build
    ├── vercel.json               # Serverless rewrite configuration
    └── README.md                 # Detailed backend documentation & API reference
```

---

## 🌐 Online Synchronization Backend (Branch: `feat/online-sync`)

In addition to running completely offline, AirREST includes an optional, cloud-native Go synchronization backend located in the `backend/` directory:

- **Private & Team Collaboration**: Supports multiple private workspaces, teams, and isolated projects.
- **Granular RBAC**: Strict permissions for Superadmin, Team Admin, Project Admin, Contributor, and Reader.
- **Conflict Management**: Optimistic Concurrency Control (OCC) with version validation and HTTP `409 Conflict` resolution.
- **Deployment Flexibility**: Run locally with Docker, deploy to any container host, or deploy directly to **Vercel** as a serverless Go function.
- **Detailed Documentation**: See [backend/README.md](backend/README.md) for full architecture, Vercel deployment steps, configuration, and API reference.

---

## 🔒 Privacy & Security

- **100% Client-Side Dispatched**: All HTTP test requests are initiated directly from your browser. Private API traffic and payloads never route through the synchronization backend.
- **Zero Corporate Data**: This is a personal open-source project. Code, documentation, and test datasets contain zero internal corporate references or proprietary domains.
- **Sandboxed Script Evaluation**: Pre-request and test scripts execute in an isolated `sandbox.html` iframe without access to cookies or extension APIs.
- **Local Storage & Cloud Sync**: Works completely offline out of the box, with optional opt-in cloud synchronization to your own private backend.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
