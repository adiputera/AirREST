# AirREST

> A fast, lightweight, and modern browser-based REST API testing studio packaged as a **Google Chrome Extension (Manifest V3)** and standalone web client with optional cloud team synchronization. Built with **React 19**, **Vite**, **Tailwind CSS v4**, **Zustand**, and a **Go + PostgreSQL** backend.

[![GitHub Repository](https://img.shields.io/badge/GitHub-adiputera%2Fapi--tester-181717?logo=github)](https://github.com/adiputera/api-tester)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-10B981.svg)](LICENSE)

---

## 🌟 Overview

AirREST is an API testing client that runs directly inside Google Chrome as a Manifest V3 extension, with an optional team management portal (AirREST Hub) and Go synchronization backend. It allows dispatching direct HTTP and HTTPS requests from the browser, managing nested collections, sharing environments, and collaborating across teams with role-based access control.

### Core Highlights
- ⚡ **Direct In-Browser Dispatching**: Chrome host permissions enable unrestricted HTTP and HTTPS requests directly from the client without CORS or mixed-content limitations.
- 💾 **Dual Storage Modes**: Works in 100% Offline Mode with local storage, or connects to Cloud Sync Mode for multi-device backup and team collaboration.
- 👥 **Workspace & Project Switcher**: Unified scope switcher between Offline Workspace and Cloud Workspaces (Personal & Team Projects) with per-scope tab/history isolation.
- 📁 **Postman v2.1 Native Compatibility**: Full import and export support for Postman Collections and Environments.
- 📜 **Sandboxed Scripting**: Pre-request and test scripting engine (`pm.*`) running in an isolated environment.
- 🏢 **AirREST Hub**: Dedicated web portal for managing teams, project permissions, and user administration.

---

## ✨ Features

### 1. 📑 Request Builder & Multi-Tab Workspace
- **Multi-Tab Interface**: Open and manage concurrent request tabs with color-coded HTTP method badges.
- **Tab Management**: Context menu with options for New Request Tab, Duplicate Tab, Close Tab, Close Other Tabs, Close Tabs to the Right, and Close All Tabs, plus middle-click closing.
- **HTTP Methods**: Full support for `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`.
- **Bidirectional URL & Query Sync**: Editing query parameters in the URL input updates the key-value table automatically, and edits within the table update the URL query string in real time. Supports multi-value keys, templated variables (`{{var}}`), and parameter toggling.
- **Unsaved Modifications Tracker**: Visual indicator dot (`●`) marks tabs with unsaved edits. Pressing <kbd>Ctrl + S</kbd> / <kbd>Cmd + S</kbd> saves updates directly into the source collection item.
- **Keyboard Shortcuts**: Quick dispatch with <kbd>Ctrl + Enter</kbd> (Windows/Linux) or <kbd>Cmd + Enter</kbd> (macOS).

### 2. 📝 Flexible Request Body Formats
- **JSON**: Code editor with 1-click **Beautify JSON** formatting, syntax validation, and **Tab / Shift+Tab keyboard indentation** support (2-space indents, multi-line block indent/outdent, and native Undo/Redo preservation).
- **GraphQL (`bodyType = 'graphql'`)**: Split-pane interface for GraphQL Query/Mutation and JSON Variables, complete with **Prettify Query** and **Beautify Variables** actions, plus Tab indentation support. Sets `Content-Type: application/json` and `POST` method automatically.
- **XML (`bodyType = 'xml'`)**: Dedicated editor with 1-click **Beautify XML** formatting and Tab indentation.
- **Raw Payloads**: Text, JSON, XML, or HTML editing with automatic `Content-Type` header handling and Tab indentation.
- **URL-Encoded Form Data (`x-www-form-urlencoded`)**: Interactive key-value table and a 1-click **Bulk Edit Mode** (`key: value` or `key=value`) with automatic encoding.
- **Multipart Form-Data (`multipart/form-data`)**: Key-value form supporting text fields and file attachments with boundary negotiation.
- **Binary Upload (`bodyType = 'binary'`)**: Drag-and-drop dropzone for raw files (images, PDFs, archives, firmware) displaying file name, size, and MIME type.

### 3. 📁 Postman v2.1 Collection Support
- **Full Schema Interoperability**: Imports and exports collections following the Postman Collection v2.1.0 schema.
- **Hierarchy Preservation**: Retains nested folders, headers, query parameters, authorization settings, request payloads, and scripts.
- **Flexible Import Methods**: Import files via drag-and-drop or direct JSON text paste.
- **Duplicate Name Resolution**: Detects matching collection names during import and offers **Import as Copy** (with new UUIDs) or **Replace** (updates existing items in place).
- **Difference Inspector**: Visual breakdown highlighting added, modified, or removed endpoints prior to replacing.
- **Clean Export**: Decomposes URLs into canonical Postman v2.1 components (`protocol`, `host`, `port`, `path`) and filters blank placeholder rows for clean compatibility with Postman desktop and web clients.
- **Collection Relocation**: Move collections between Offline storage and Cloud Workspaces or across projects within the same team.
- **Search & Filter**: Real-time filtering across collections, folders, and individual endpoints.
- **Confirmation Modals**: Dialog prompts require explicit confirmation before deleting collections.

### 4. 🌍 Environment Variables & Dynamic Templating
- **Environment Switcher**: Quick-switch between environments (e.g., Localhost, Development, Staging, Production) from the header dropdown.
- **Postman Environment Import & Export**: Import and export standard Postman environment files with duplicate resolution and a visual variable differences breakdown (`+Added`, `~Modified`, `-Removed`, `Same`).
- **Variable Interpolation**: Use `{{variableName}}` across request URLs, headers, query parameters, authentication fields, and request bodies.
- **Syntax Highlighting & Tooltips**: Color-coded variable tags in editors (amber for resolved, rose for unresolved) with hover tooltips displaying resolved values and source environment.
- **Live Resolved URL Preview**: Displays the evaluated URL directly under the address bar before sending.
- **Built-in Dynamic Variables**:
  - `{{$guid}}` — Random UUID v4.
  - `{{$timestamp}}` — Current Unix timestamp in seconds.
  - `{{$isoTimestamp}}` — Current ISO 8601 UTC date-time string.
  - `{{$randomInt}}` — Random integer between 1 and 1000.
- **Role-Based Environment Access**: Configure environment visibility in team projects using minimum-role settings (`All Members`, `Contributor+`, `Maintainer+`, or `Admin Only`).

### 5. 🔐 Authorization Suite
- **Supported Auth Types**:
  - **Bearer Token**: Token field with dynamic variable support (e.g. `{{token}}`).
  - **Basic Auth**: Auto-encoded Base64 username and password.
  - **API Key**: Configurable key/value pairs passed via Headers or Query Parameters.
  - **OAuth 2.0**: Extracts bearer tokens from imported Postman configurations.
- **Inheritance Hierarchy**: Cascades authentication configurations from collections down to nested folders and requests, with per-request override and `noauth` options.

### 6. 💻 cURL Integration
- **Copy as cURL**: Generates shell-ready cURL commands with resolved variables, query parameters, headers, and request bodies.
- **Import from cURL**: Parses cURL commands from terminals or browser DevTools into the active request builder (supports `-X`, `-H`, `-d`, `--json`, `--data-binary`, `-F`, `-u`, `-b`, and query parameters).

### 7. 📜 Sandboxed Scripting Engine
- **Pre-Request Scripts**: Run JavaScript before request dispatch to compute headers, timestamps, or signatures, with full Tab indentation support.
- **Post-Response Scripts**: Inspect responses programmatically with `pm.response.code`, `pm.response.headers`, and `pm.response.json()`.
- **Dynamic Variable Chaining**: Save tokens or values to the active environment via `pm.environment.set("key", value)` for downstream requests.
- **Isolated Execution**: Runs scripts within an isolated Manifest V3 sandbox (`sandbox.html`).
- **Test Feedback**: Shows assertions and script output in the response viewer.

### 8. 📊 Response Inspector
- **Execution Metrics**: Shows HTTP status code, round-trip latency (`ms`), and payload byte size.
- **Format Views**:
  - **Pretty / Raw View**: Formatted JSON with syntax highlighting and raw text toggle.
  - **Image Preview**: Renders images (`webp`, `png`, `jpeg`, `gif`, `svg`, `avif`) with dimensions, transparency background, and full-screen view.
  - **Binary File Card**: Displays details for non-image binary downloads with a 1-click native file download button.
  - **Headers Table**: Structured view of response headers.
- **Export Options**: 1-click response body copy and file download with automatic extension resolution.

### 9. 🕒 History & Persistent Storage
- **Dispatched Request Log**: Automatically records requests with status codes and execution timestamps.
- **IndexedDB Storage**: Uses IndexedDB with the `unlimitedStorage` permission to support large collections and environments without 5MB storage limits.
- **Local Persistence**: Restores open tabs, unsaved modifications, and active configuration across browser reloads.

### 10. 👥 Teams, Projects & Cloud Synchronization
- **Scope Switcher**: Switch between Offline LocalStorage and Cloud Workspaces (Personal & Team Projects) with RBAC role badges (`Admin`, `Maintainer`, `Contributor`, `Reader`).
- **Scoped Data Isolation**: Separate tabs, history, and active environments per workspace scope.
- **Smart Client Caching**: 1-hour cache enables instant project switching without redundant network fetches.
- **Manual Sync**: Dedicated sync button to trigger immediate synchronization with the cloud backend.
- **Rolling Refresh Tokens**: 30-day token rotation with background refresh keeps active sessions connected.
- **Optimistic Concurrency Control (OCC)**: Version-checked updates handle concurrent modifications cleanly.

### 11. 🏢 AirREST Hub Management Portal
- **Dedicated Dashboard**: Independent web application (`hub/`) for team and project management.
- **Team Management**: Create and configure teams, invite members, and assign roles.
- **Project Administration**: Manage projects and assign member permissions (`Admin`, `Maintainer`, `Contributor`, `Reader`).
- **Resource Permissions**: Configure minimum role requirements per collection and environment.
- **Superadmin Tools**: User account management, password resets, and system overview.

---

## 🚀 Getting Started

### 1. Build and Install the Chrome Extension

AirREST supports two build targets:

| Edition | Build Command | Output Directory | Description |
|---|---|---|---|
| **Offline Only** | `npm run build:offline` | `extension/dist-offline/` | 100% offline mode with minimal permissions. |
| **Full (Cloud + Offline)** | `npm run build` | `extension/dist/` | Dual-mode edition with local storage and cloud sync. |
| **Both Editions** | `npm run build:all-extensions` | `extension/dist/` & `extension/dist-offline/` | Builds both packages simultaneously. |

```bash
# Clone the repository
git clone git@github.com:adiputera/api-tester.git
cd api-tester

# Install dependencies
npm install

# Build the extension
npm run build
```

**Load the extension into Google Chrome:**
1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select `extension/dist/` (or `extension/dist-offline/`).

### 2. Run the AirREST Hub Portal (Optional)

```bash
# Start Hub locally
npm run dev:hub

# Or build for production
npm run build:hub
```

Deploying to Vercel:
1. Import the repository in the Vercel Dashboard.
2. Set **Root Directory** to `hub`.
3. Set Framework Preset to **Vite** and click **Deploy**.

### 3. Run the Cloud Synchronization Backend (Optional)

```bash
cd backend

# Copy sample configuration
cp .env.example .env

# Start PostgreSQL database with Docker
docker compose up -d postgres

# Start the Go server
go run cmd/server/main.go
```
The server listens at `http://localhost:8080`, automatically applies database migrations, and provisions the initial Superadmin account (`admin@example.com`).

---

## ⚙️ Configuration

### Backend Environment Variables (`backend/.env`)

| Variable | Required | Default / Example | Description |
|---|---|---|---|
| `PORT` | Optional | `8080` | Port for the HTTP server to listen on. |
| `DATABASE_URL` | **Yes** | `postgres://airrest:airrest_secret_password@localhost:5432/airrest_db?sslmode=disable` | PostgreSQL connection string. |
| `JWT_SECRET` | **Yes** | `super-secret-jwt-key-change-in-production-minimum-32-chars` | HS256 JWT signing secret (minimum 32 characters). |
| `JWT_EXPIRATION_HOURS` | Optional | `72` | Access token lifespan in hours. |
| `JWT_REFRESH_EXPIRATION_DAYS` | Optional | `30` | Rolling refresh token lifespan in days. |
| `SUPERADMIN_EMAIL` | Optional | `admin@example.com` | Email for the initial Superadmin account. |
| `SUPERADMIN_PASSWORD` | Optional | `SuperadminSecurePassword123!` | Password for the initial Superadmin account. |
| `SUPERADMIN_NAME` | Optional | `Super Administrator` | Display name for the Superadmin account. |
| `DB_MAX_CONNS` | Optional | `25` (Docker) / `4` (Vercel) | Maximum concurrent connections in `pgxpool`. |
| `DB_MIN_CONNS` | Optional | `2` (Docker) / `1` (Vercel) | Minimum idle connections in `pgxpool`. |
| `SKIP_MIGRATIONS` | Optional | `false` | Skips database migrations on startup when set to `true`. |

### Hub Environment Variables (`hub/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | Optional | `http://localhost:8080` | Default backend API URL for the Hub web client. |

---

## 🛠 Development Scripts

### Workspace Root (Node.js)

| Command | Description |
|---|---|
| `npm run dev` | Runs the Vite dev server for the Chrome Extension |
| `npm run dev:offline` | Runs the Vite dev server in offline-only mode |
| `npm run build` | Builds the full Chrome Extension (`extension/dist/`) |
| `npm run build:offline` | Builds the offline-only Chrome Extension (`extension/dist-offline/`) |
| `npm run build:all-extensions` | Compiles both Chrome Extension editions |
| `npm run dev:hub` | Runs the Vite dev server for AirREST Hub |
| `npm run build:hub` | Builds the production bundle for AirREST Hub |
| `npm run build:all` | Compiles all targets (Extension and Hub) |
| `npm run preview` | Previews the production extension build locally |
| `npm run typecheck` | Validates TypeScript types across extension and hub |
| `npm run lint` | Runs ESLint validation across the repository |

### Backend (Go & Docker)

| Command | Description |
|---|---|
| `cd backend && docker compose up -d postgres` | Starts the local PostgreSQL container |
| `cd backend && go run cmd/server/main.go` | Starts the Go REST API server on `:8080` |
| `cd backend && go test -v ./...` | Runs the backend test suite |
| `cd backend && docker compose down` | Stops the PostgreSQL container |

---

## 📦 Project Structure

```
├── .gitignore                    # Ignore rules (.env, build outputs, dependencies)
├── package.json                  # Root npm workspace configuration (workspaces: ["extension", "hub"])
├── package-lock.json
├── eslint.config.mjs             # Monorepo ESLint configuration
├── tsconfig.json                 # Workspace root TypeScript configuration
│
├── extension/                    # Chrome Extension (Manifest V3 + React 19 + Tailwind CSS v4)
│   ├── dist/                     # Compiled full edition
│   ├── dist-offline/             # Compiled offline-only edition
│   ├── public/                   # Static extension assets (manifest.json, sandbox.html, service-worker.js, icons)
│   ├── src/                      # Extension source code
│   │   ├── components/           # UI components (Header, RequestEditor, ResponseViewer, Modals)
│   │   ├── lib/                  # Core utilities (cURL, fetcher, postman, scriptRunner, cloudApi)
│   │   ├── store/                # Zustand persistent application store
│   │   ├── types/                # TypeScript interfaces and models
│   │   ├── App.tsx               # Main application shell
│   │   ├── index.css             # Tailwind CSS v4 stylesheets
│   │   └── main.tsx              # React DOM entrypoint
│   ├── index.html                # Extension window HTML
│   ├── package.json              # Extension dependencies & scripts
│   ├── tsconfig.json             # Extension TypeScript configuration
│   └── vite.config.ts            # Extension Vite bundler configuration
│
├── hub/                          # AirREST Hub web portal (Vite + React 19 + Tailwind CSS v4)
│   ├── src/                      # Hub pages (Teams, Projects, Superadmin, Connect)
│   ├── dist/                     # Hub build output
│   ├── package.json              # Hub dependencies
│   ├── vercel.json               # Hub Vercel routing configuration
│   └── vite.config.ts            # Hub Vite configuration
│
└── backend/                      # Go REST synchronization service (Chi + PostgreSQL + pgx)
    ├── api/                      # Vercel Serverless Function entrypoint (index.go)
    ├── cmd/server/               # Standalone server entrypoint (main.go)
    ├── config/                   # Configuration loader
    ├── core/                     # Domain models, handlers, middleware, repositories, services
    │   ├── domain/               # Core data models (User, Team, Project, Collection, Item)
    │   ├── handler/              # HTTP REST handlers (Auth, Sync, Workspace, Admin)
    │   ├── middleware/           # JWT auth, CORS, and logging middleware
    │   ├── repository/           # PostgreSQL queries & migrations
    │   └── service/              # Business logic & Optimistic Concurrency Control
    ├── pkg/                      # Shared packages (hasher, response, token)
    ├── .env.example              # Sanitized configuration template
    ├── docker-compose.yml        # PostgreSQL container setup
    ├── Dockerfile                # Production container build
    ├── vercel.json               # Vercel serverless rewrite configuration
    └── README.md                 # Backend documentation & API reference
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
