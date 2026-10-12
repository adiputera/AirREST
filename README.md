# AirREST

> A fast, lightweight, and modern browser-based REST API testing studio packaged as a **Google Chrome Extension (Manifest V3)** and standalone web client. Built with **React 19**, **Vite**, **Tailwind CSS v4**, and **Zustand**.

[![GitHub Repository](https://img.shields.io/badge/GitHub-adiputera%2Fapi--tester-181717?logo=github)](https://github.com/adiputera/api-tester)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-38B2AC?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-10B981.svg)](LICENSE)

---

## ⚡ Why AirREST?

Most web-based API testing tools are severely constrained by browser security models: CORS preflight restrictions, mixed-content blocking (refusing to send unencrypted HTTP calls from HTTPS domains), and strict private network limits. Desktop clients such as Postman or Insomnia are feature-rich but heavy, consume considerable memory, and frequently require cloud account synchronization.

**AirREST provides an agile, zero-friction alternative by running directly in your browser as a Chrome Extension (Manifest V3):**

- 🛡️ **Zero CORS & Mixed-Content Blocks**: Chrome host permissions (`<all_urls>`) allow direct, unrestricted HTTP and HTTPS dispatching from your browser.
- 💻 **Localhost & Private Network Ready**: Seamlessly test local development servers (`http://localhost:3000`, `http://127.0.0.1:8080`) and private subnets (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`) without running external desktop proxies.
- 📁 **Native Postman v2.1 Compatibility**: Import and export standard Postman Collections and Environments without vendor lock-in.
- 🔒 **100% Client-Side & Private**: Your requests, collections, credentials, and environment tokens are stored purely in local storage. No tracking, no external middleman server, no mandatory accounts.

---

## 🚀 Quick Start: Install as Chrome Extension

You can load AirREST directly into Google Chrome, Microsoft Edge, Brave, or Chromium in Developer Mode in under a minute:

### 1. Build the Extension Bundle
```bash
# Clone the repository
git clone git@github.com:adiputera/api-tester.git
cd api-tester

# Install dependencies
npm install

# Build the production extension
npm run build
```
The build output will be compiled into the `dist/` directory.

### 2. Load into Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable the **Developer mode** toggle in the upper-right corner.
3. Click the **Load unpacked** button in the upper-left corner.
4. Select the **`dist/`** directory located in your cloned `api-tester` folder.

🎉 **Done!** The AirREST icon will appear in your Chrome extensions toolbar. Click it anytime to open the studio in a full browser tab.

---

## ✨ Features

### 1. 📁 Postman v2.1 Collection Import & Export
- **Two-way Interoperability**: Full support for the standard Postman Collection `v2.1.0` JSON schema.
- **Deep Hierarchy Preservation**: Preserves nested folder trees, query parameters, header tables, request bodies, and scripting hooks.
- **Flexible Import**: Import collections via drag-and-drop file upload or direct JSON text paste.
- **1-Click Export**: Export any individual collection directly from the sidebar or global header to Postman v2.1 JSON to share with teammates.
- **Real-Time Search**: Instant filtering across collection names, folders, and nested request endpoints.
- **Sample Collection**: One-click demo loader with pre-configured endpoints and assertions for quick testing.

### 2. 🌍 Environment Variables & Dynamic Templating
- **Environment Switcher**: Create and switch between environments (e.g., `Localhost`, `Development`, `Staging`, `Production`) directly from the header dropdown.
- **Postman Environment Interoperability**: Import and export Postman Environment `.json` files.
- **Syntax Highlighting for Variables**: Monospace syntax highlighting for `{{variableName}}` inside request URLs, Authorization credentials, query parameters, and header tables with amber (resolved) and rose (unresolved) indicators.
- **Interactive Hover Tooltip Popups**: Hovering over any `{{variableName}}` reveals a floating inspector displaying its resolved value, current environment scope, and resolution suggestions.
- **Live Resolved URL Preview**: Real-time evaluation banner beneath the URL bar displaying the fully interpolated endpoint before dispatch.
- **Variable Interpolation**: Use `{{variableName}}` across request URLs, query parameters, custom headers, authentication credentials, and request bodies.
- **Built-in Postman Dynamic Variables**:
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
- **Save to Collection**: Save active or modified requests directly to collections and subfolders.

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

| Command | Description |
|---|---|
| `npm run dev` | Runs the local Vite development server |
| `npm run build` | Builds the production Chrome Extension bundle into `dist/` |
| `npm run preview` | Previews the production build locally |
| `npm run lint` | Runs ESLint validation |

---

## 📦 Project Structure

```
├── dist/                         # Compiled Chrome extension (load unpacked in chrome://extensions)
│   ├── index.html                # Extension main window HTML
│   ├── manifest.json             # Chrome Manifest V3 manifest
│   ├── sandbox.html              # Isolated script execution sandbox
│   ├── service-worker.js         # Extension background service worker
│   ├── icons/                    # Extension icons (16px, 48px, 128px)
│   └── assets/                   # Compiled JavaScript and CSS bundles
├── public/                       # Static assets copied into dist during build
│   ├── manifest.json
│   ├── sandbox.html
│   ├── service-worker.js
│   └── icons/
├── src/
│   ├── components/
│   │   ├── EnvironmentModal.tsx        # Environment manager modal & Postman env import/export
│   │   ├── Header.tsx                  # Top header, environment selector, global actions
│   │   ├── ImportModal.tsx             # Postman Collection & cURL import modal
│   │   ├── KeyValueEditor.tsx          # Dynamic table editor for Params and Headers
│   │   ├── MethodBadge.tsx             # Color-coded badge for HTTP methods
│   │   ├── RequestEditor.tsx           # Request editor (URL, method, headers, body, scripts)
│   │   ├── ResponseViewer.tsx          # Response status, latency, pretty JSON, and headers
│   │   ├── SaveToCollectionModal.tsx   # Modal to save requests to collections/folders
│   │   ├── Sidebar.tsx                 # Collections tree and request history
│   │   ├── TabBar.tsx                  # Multi-tab request management
│   │   └── VariableInput.tsx           # Monospace variable highlighter & hover popups
│   ├── lib/
│   │   ├── curl.ts                     # cURL command generator and parser
│   │   ├── fetcher.ts                  # Fetch engine with variable interpolation & form-data
│   │   ├── postman.ts                  # Postman v2.1 collection & environment parser/exporter
│   │   ├── scriptRunner.ts             # Sandboxed runner for pm.* scripts
│   │   └── urlParams.ts                # Two-way URL bar and query parameters synchronization
│   ├── store/
│   │   └── useApiStore.ts              # Zustand store with persistent storage
│   ├── types/
│   │   └── api.ts                      # TypeScript data models and interfaces
│   ├── App.tsx                         # Studio layout shell
│   ├── index.css                       # Tailwind CSS v4 styling
│   └── main.tsx                        # React DOM entrypoint
├── index.html                          # Root HTML template for Vite
├── package.json
├── tsconfig.json
└── vite.config.ts                      # Vite build configuration
```

---

## 🔒 Privacy & Security

- **100% Client-Side**: All HTTP requests are initiated directly from your browser. There is no intermediate proxy or remote relay server.
- **Sandboxed Script Evaluation**: Pre-request and test scripts execute in an isolated `sandbox.html` iframe without access to cookies or extension APIs.
- **Local Storage Only**: Collections, environments, history, and tokens are stored in the browser's local storage and never leave your computer.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
