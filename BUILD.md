# AirREST Build & Deployment Guide

> Comprehensive guide for building, packaging, running, and deploying AirREST across all supported target platforms: **Google Chrome Extension (Manifest V3)**, **Desktop Application (macOS, Windows, Linux)**, **Android Application (APK & AAB)**, **AirREST Hub Portal**, and the **Go Synchronization Backend**.

---

## 📋 Table of Contents

- [Prerequisites](#-prerequisites)
- [1. Chrome Extension (Manifest V3)](#1-chrome-extension-manifest-v3)
  - [Build Targets](#build-targets)
  - [Building from Source](#building-from-source)
  - [Loading into Google Chrome](#loading-into-google-chrome)
  - [Local Development Server](#local-development-server)
- [2. Desktop Application (Tauri v2)](#2-desktop-application-tauri-v2)
  - [Development Mode](#development-mode)
  - [Building Native Installers](#building-native-installers)
  - [Desktop Auto-Updater & Code Signing](#desktop-auto-updater--code-signing)
  - [Automated Multi-OS Releases (GitHub Actions)](#automated-multi-os-releases-github-actions)
- [3. Android Application (Tauri v2)](#3-android-application-tauri-v2)
  - [Prerequisites & Environment Setup](#prerequisites--environment-setup)
  - [Android Development & Emulation](#android-development--emulation)
  - [Building Release APK & App Bundle (AAB)](#building-release-apk--app-bundle-aab)
  - [Release Signing & Versioning](#release-signing--versioning)
- [4. AirREST Hub Management Portal](#4-airrest-hub-management-portal)
  - [Local Development](#local-development)
  - [Production Bundle](#production-bundle)
  - [Deploying to Vercel](#deploying-to-vercel)
- [5. Cloud Synchronization Backend (Go + PostgreSQL)](#5-cloud-synchronization-backend-go--postgresql)
  - [Local Development with Docker](#local-development-with-docker)
  - [Deploying to Vercel Serverless](#deploying-to-vercel-serverless)
  - [Database Migrations & Concurrency Safety](#database-migrations--concurrency-safety)
- [6. Environment Variables Reference](#6-environment-variables-reference)
  - [Backend Configuration (`backend/.env`)](#backend-configuration-backendenv)
  - [Hub Configuration (`apps/hub/.env`)](#hub-configuration-appshubenv)
- [7. Complete Scripts & Testing Reference](#7-complete-scripts--testing-reference)
  - [Workspace Root Scripts](#workspace-root-scripts)
  - [Automated Regression Test Matrix](#automated-regression-test-matrix)
  - [Backend Go Test Suite](#backend-go-test-suite)

---

## 🛠 Prerequisites

Before building AirREST, ensure your system has the following tools installed:

| Tool | Minimum Version | Required For |
|---|---|---|
| **Node.js** | `>= 20.0.0` | Extension, Hub, Native frontend, common package |
| **npm** | `>= 10.0.0` | Workspace dependency management |
| **Rust & Cargo** | `>= 1.77.0` | Tauri v2 Desktop and Android targets |
| **Go** | `>= 1.22` (1.26 recommended) | Backend synchronization service |
| **Docker & Compose** | Latest | Local PostgreSQL database instance |
| **Android SDK / NDK** | API 36 / NDK 27 | Android APK & AAB builds |

---

## 1. Chrome Extension (Manifest V3)

The browser extension runs directly inside Chromium-based browsers (Google Chrome, Microsoft Edge, Brave, Arc, Opera) using Manifest V3 host permissions.

> [!TIP]
> If you prefer installing without building from source, install AirREST directly from the official [Chrome Web Store](https://chromewebstore.google.com/detail/airrest-rest-client/kpajbolnoepgalhoinilfdfpcmgbdlld).

### Build Targets

AirREST supports two distinct extension editions:

| Edition | Build Command | Output Directory | Description |
|---|---|---|---|
| **Offline Only** | `npm run build:offline` | `apps/extension/dist-offline/` | 100% offline mode with minimal permissions and local storage only. |
| **Full (Cloud + Offline)** | `npm run build` | `apps/extension/dist/` | Dual-mode edition with local storage and cloud team synchronization. |
| **Both Editions** | `npm run build:all-extensions` | `apps/extension/dist/` & `apps/extension/dist-offline/` | Builds both distribution packages simultaneously. |

### Building from Source

```bash
# Clone the repository
git clone https://github.com/adiputera/AirREST.git
cd AirREST

# Install all monorepo dependencies
npm install

# Build the Full extension
npm run build

# Or build the Offline-only edition
npm run build:offline
```

### Loading into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the build output directory:
   - For Full edition: Select `apps/extension/dist/`.
   - For Offline edition: Select `apps/extension/dist-offline/`.
5. Pin the **AirREST** extension to your toolbar.

### Local Development Server

```bash
# Start Vite development server for Extension
npm run dev

# Or development server in offline mode
npm run dev:offline
```

---

## 2. Desktop Application (Tauri v2)

AirREST Desktop packages the studio as a lightweight native application powered by Tauri v2 with React 19 and a Rust core.

### Development Mode

```bash
# Run desktop client in development mode
npm run dev:desktop
# (Alias for npm run dev:native)
```

### Building Native Installers

```bash
# Compile native binary/installer for your current OS
npm run build:desktop
# (Alias for npm run build:native, outputs to apps/native/src-tauri/target/release/bundle/)
```

Supported installer packages generated per operating system:
- **macOS**: `.dmg` disk image and `.app` bundle (Apple Silicon `aarch64` and Intel `x86_64`).
- **Linux**: `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), and `.AppImage`.
- **Windows**: `.msi` (WiX) and `.exe` (NSIS).

### Desktop Auto-Updater & Code Signing

The desktop auto-updater plugin (`@tauri-apps/plugin-updater`) is conditionally compiled when a public signature key is supplied. To build desktop releases with auto-update capabilities enabled:

```bash
TAURI_UPDATER_PUBLIC_KEY="<your-public-key-here>" npm run build:desktop
```

If omitted, updater checks log an informational warning and remain inactive without crashing the application. Releases are cryptographically signed using repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_UPDATER_PUBLIC_KEY`.

### Automated Multi-OS Releases (GitHub Actions)

The repository includes a cross-platform release workflow (`.github/workflows/desktop-release.yml`):
1. **Version Bump**: Run `npm run version:desktop -- <version>` (e.g. `npm run version:desktop -- 1.3.2`) to synchronize version strings across `package.json`, `tauri.conf.json`, `Cargo.toml`, and `apps/hub/package.json`.
2. **Git Tag Trigger**: Push a version tag matching `desktop-v*` or `v*`:
   ```bash
   git tag desktop-v1.3.2
   git push origin desktop-v1.3.2
   ```
3. **Manual Trigger**: Run the **Release AirREST (Desktop & Android)** workflow from the GitHub Actions tab (`workflow_dispatch`).
4. **Parallel Builds and Updater Publication**: Android and all four desktop targets build in parallel. Desktop jobs upload signed installers without writing `latest.json`. Once every desktop job succeeds, `publish-updater` generates one complete manifest from the release assets and their `.sig` files. Missing targets or invalid signatures fail the job before upload. Releases without updater signing configured skip this job. Workflow runs are serialized to prevent simultaneous releases from replacing the same manifest.

To repair an existing release without rebuilding installers (Node.js 22+):

```bash
node scripts/generate-updater-manifest.mjs --repo OWNER/REPO --tag v1.3.6 --output /tmp/latest.json
# After reviewing the manifest, upload with an authenticated GitHub CLI:
gh release upload v1.3.6 /tmp/latest.json --clobber --repo OWNER/REPO
```

The generator reads public releases without authentication. For a private or draft release, provide `GITHUB_TOKEN` or `GH_TOKEN` with repository contents read access. Upload requires contents write access. All four desktop targets and their original signatures must be present; Android assets are handled by the Android updater separately.

---

## 3. Android Application (Tauri v2)

The Android target shares the universal React application in `packages/common` with mobile-adapted popovers, native file picker dialogs, back-button handling, and an isolated QuickJS WebAssembly engine.

### Prerequisites & Environment Setup

1. Install Rust Android targets:
   ```bash
   rustup target add aarch64-linux-android x86_64-linux-android
   ```
2. Install Android Studio, Android SDK (API 36), Build Tools, and NDK (version 27 or later).
3. Export required environment variables in your shell profile:
   ```bash
   export ANDROID_HOME="$HOME/Android/Sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/<version>"
   export JAVA_HOME="/path/to/jdk-17"
   export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
   ```

### Android Development & Emulation

```bash
# Launch Android dev server on a connected device or running emulator
npm run dev:android

# Build a debug APK for the x86_64 Android Emulator
npm run build:android:emulator
```

> [!TIP]
> When testing requests against a backend running on your development host machine, the Android Emulator uses `10.0.2.2` as the host loopback alias instead of `localhost`.

### Building Release APK & App Bundle (AAB)

```bash
# Build ARM64 Release APK (outputs to apps/native/src-tauri/gen/android/app/build/outputs/apk/)
npm run build:android

# Build ARM64 Android App Bundle (AAB) for Google Play distribution
npm run build:android:bundle
```

### Release Signing & Versioning

Supply all four environment variables to sign release APKs and AABs during Gradle builds:
- `AIRREST_ANDROID_KEYSTORE_PATH` (absolute path to `.jks` or `.keystore` file)
- `AIRREST_ANDROID_KEYSTORE_PASSWORD`
- `AIRREST_ANDROID_KEY_ALIAS`
- `AIRREST_ANDROID_KEY_PASSWORD`

With the variables exported, build signed artifacts from the repository root:
```bash
npm run --prefix apps/native tauri -- android build --apk --aab --target aarch64 --ci
```

Tauri automatically derives `versionCode` from `tauri.conf.json` using the formula `major * 1000000 + minor * 1000 + patch` (e.g., `1.3.2` becomes `1003002`).

---

## 4. AirREST Hub Management Portal

AirREST Hub is the companion web portal (`apps/hub/`) for team collaboration, member role delegation, and project administration.

### Local Development

```bash
# Start Hub dev server (http://localhost:5173)
npm run dev:hub

# Or from within apps/hub directory
cd apps/hub
npm run dev
```

### Production Bundle

```bash
# Build Hub for production (apps/hub/dist/)
npm run build:hub
```

### Deploying to Vercel

1. In the [Vercel Dashboard](https://vercel.com/dashboard), import the repository.
2. In Project Settings:
   - **Root Directory**: Set to **`apps/hub`** *(not `hub`)*.
   - **Framework Preset**: **Vite**.
   - **Build Command**: `vite build` (auto-detected).
   - **Output Directory**: `dist` (auto-detected).
3. *(Optional)* Add Environment Variable:
   - `VITE_API_URL`: Your deployed backend URL (e.g. `https://api.yourdomain.com`). If omitted, defaults to `http://localhost:8080`.
4. SPA routing rewrites are pre-configured in `apps/hub/vercel.json`. Click **Deploy**.

---

## 5. Cloud Synchronization Backend (Go + PostgreSQL)

The backend provides cloud persistence, hierarchical RBAC, and Optimistic Concurrency Control (OCC) using Go and PostgreSQL.

### Local Development with Docker

```bash
cd backend

# Copy sample configuration
cp .env.example .env

# Generate a strong 32-byte JWT secret
openssl rand -hex 32

# Configure JWT_SECRET, SUPERADMIN_EMAIL, and SUPERADMIN_PASSWORD in backend/.env

# Start local PostgreSQL database
docker compose up -d postgres

# Start Go backend server (listens on :8080)
go run cmd/server/main.go
```

The server automatically applies database migrations from embedded SQL files and provisions the bootstrap Superadmin account on first launch.

### Deploying to Vercel Serverless

The Go backend natively runs as a Vercel Serverless Function via `@vercel/go`:
1. In the [Vercel Dashboard](https://vercel.com/dashboard), click **Add New...** -> **Project** and import this repository.
2. In Project Settings:
   - **Root Directory**: Set to **`backend`**.
   - **Framework Preset**: Auto-detected as **Other** or **Go**.
3. Configure Environment Variables:
   - `DATABASE_URL`: Cloud PostgreSQL connection string (with pooled connection and `?sslmode=require`).
   - `JWT_SECRET`: High-entropy signing key (minimum 32 characters).
   - `SUPERADMIN_EMAIL`: Initial Superadmin email.
   - `SUPERADMIN_PASSWORD`: Strong password (12–72 bytes).
   - `SKIP_MIGRATIONS`: Recommended `true` for Production (see migration strategy below).
4. Click **Deploy**. Incoming requests `/(.*)` are routed to `api/index.go` via `backend/vercel.json`.

### Database Migrations & Concurrency Safety

* **Transaction-Scoped Advisory Lock**: Boot migrations acquire `pg_advisory_xact_lock` per version, eliminating race conditions during simultaneous serverless cold starts.
* **Fail-Fast DDL**: Migrations use `lock_timeout = 5s` and `statement_timeout = 60s` to prevent blocking production queries.
* **Initialization Deadlines**: Serverless startup allows 20 seconds when `SKIP_MIGRATIONS=true`, and 120 seconds when migrations run.

---

## 6. Environment Variables Reference

### Backend Configuration (`backend/.env`)

| Variable | Required | Default / Example | Purpose |
|---|---|---|---|
| `PORT` | Optional | `8080` | Port for the HTTP server to listen on. |
| `DATABASE_URL` | **Yes** | `postgres://airrest:secret@localhost:5432/airrest_db?sslmode=disable` | PostgreSQL connection string. |
| `JWT_SECRET` | **Yes** | Generated 32+ character hex string | High-entropy signing key for HS256 JWT tokens. |
| `JWT_EXPIRATION_HOURS` | Optional | `72` | Access token lifespan in hours. |
| `JWT_REFRESH_EXPIRATION_DAYS` | Optional | `30` | Rolling refresh token lifespan in days. |
| `SUPERADMIN_EMAIL` | First startup | User-supplied email | Email for initial Superadmin account. |
| `SUPERADMIN_PASSWORD` | First startup | User-supplied password (12–72 bytes) | Password for initial Superadmin account. |
| `SUPERADMIN_NAME` | Optional | `Super Administrator` | Display name for initial Superadmin account. |
| `DB_MAX_CONNS` | Optional | `25` (Docker) / `4` (Vercel) | Maximum concurrent connections in `pgxpool`. |
| `DB_MIN_CONNS` | Optional | `2` (Docker) / `1` (Vercel) | Minimum idle connections in `pgxpool`. |
| `SKIP_MIGRATIONS` | Optional | `false` | Skips database migrations on startup when set to `true`. |

### Hub Configuration (`apps/hub/.env`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VITE_API_URL` | Optional | `http://localhost:8080` | Backend API URL for the Hub web management client. |

---

## 7. Complete Scripts & Testing Reference

### Workspace Root Scripts

| Command | Target / Description |
|---|---|
| `npm run dev` | Runs Vite dev server for Chrome Extension |
| `npm run dev:offline` | Runs Vite dev server in offline-only mode |
| `npm run build` | Builds Full Chrome Extension (`apps/extension/dist/`) |
| `npm run build:offline` | Builds Offline Chrome Extension (`apps/extension/dist-offline/`) |
| `npm run build:all-extensions` | Compiles both Chrome Extension editions |
| `npm run dev:desktop` | Runs Tauri v2 Desktop client in development mode |
| `npm run build:desktop` | Compiles Tauri v2 native desktop installers |
| `npm run dev:android` | Runs Android app in development mode on device/emulator |
| `npm run build:android` | Builds ARM64 release APK |
| `npm run build:android:bundle` | Builds ARM64 release Android App Bundle (AAB) |
| `npm run build:android:emulator` | Builds debug APK for x86_64 emulator |
| `npm run dev:hub` | Runs Vite dev server for AirREST Hub |
| `npm run build:hub` | Builds production bundle for AirREST Hub (`apps/hub/dist/`) |
| `npm run build:all` | Compiles Extension, Offline Extension, and Hub |
| `npm run typecheck` | Validates TypeScript types across `packages/common`, `apps/extension`, `apps/hub`, and `apps/native` |
| `npm run lint` | Runs ESLint validation across all monorepo packages |
| `npm run test:all` | **Executes full automated regression test suite** (19 suites) |

### Automated Regression Test Matrix

Individual regression test suites can be executed independently:

```bash
# Security & Client Policies
npm run test:security-clients
npm run test:feature-policy

# Chrome Extension Specifics
npm run test:extension-lifecycle
npm run test:extension-storage
npm run test:extension-fetcher

# Native & Android Targets
npm run test:desktop-sandbox
npm run test:desktop-transport
npm run test:desktop-updater
npm run test:tauri-files
npm run test:android-back
npm run test:android-update
npm run test:tauri-http-scope

# Shared UI & Core Logic
npm run test:theme
npm run test:payload-builder
npm run test:tab-response-cache
npm run test:sidebar-search
npm run test:sidebar-dropdown-placement
npm run test:scope-switcher-placement
npm run test:path-variables
npm run test:request-collapse
npm run test:collection-permission
npm run test:collection-sync-retry
npm run test:environment-draft-sync
npm run test:cloud-compression
npm run test:hub
```

### Backend Go Test Suite

```bash
cd backend

# Run all unit tests
go test -v ./...

# Run integration tests against a disposable PostgreSQL instance
docker run --rm -d --name airrest-test-db \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=airrest_test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine

AIRREST_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/airrest_test?sslmode=disable' \
  go test -race -count=1 ./...

docker stop airrest-test-db
```

