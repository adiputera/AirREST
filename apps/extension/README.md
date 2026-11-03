# AirREST Chrome Extension

> Fast, lightweight, and modern browser-based REST API testing studio running directly inside Google Chrome as a **Manifest V3** extension with zero CORS limitations.

---

## 🌟 Overview

The AirREST Chrome Extension is built on Manifest V3 and leverages browser host permissions to dispatch direct HTTP and HTTPS requests from the client without proxy servers, CORS headers, or mixed-content restrictions.

### Editions

1. **Full Edition (`apps/extension/dist/`)**:
   - Includes local storage persistence (IndexedDB).
   - Connects optionally to the AirREST Go cloud synchronization backend for team collaboration, multi-workspace sync, and RBAC permissions.
2. **Offline Edition (`apps/extension/dist-offline/`)**:
   - 100% offline, privacy-first edition with zero cloud network connectivity permissions.
   - All collections, environments, and history remain strictly inside browser storage.
   - Features dedicated emerald-green offline icons.

---

## 🛠 Building & Installation

From the workspace root:

```bash
# Build the Full edition
npm run build

# Build the Offline edition
npm run build:offline

# Build both editions simultaneously
npm run build:all-extensions
```

### Loading in Google Chrome

1. Navigate to `chrome://extensions/` in Chrome.
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select `apps/extension/dist/` (or `apps/extension/dist-offline/`).

---

## 🛡️ Architecture & Security

- **Thin Platform Adapter**: The extension UI and state logic are powered by the shared core `@airrest/common` library, with extension-specific APIs encapsulated in `src/adapters/chromeAdapter.ts`.
- **Sandboxed Scripting**: Pre-request automation and post-response assertion scripts (`pm.*` & `postman.*`) execute inside an isolated iframe (`sandbox.html`) bounded by strict CSP headers and an execution timeout guard.
- **5-Minute Request Deadline**: Built-in 300-second (5-minute) execution deadline and a 10 MiB response body stream limit prevent hung connections and memory exhaustion.

For complete repository build and deployment instructions, see [BUILD.md](../../BUILD.md).

---

## 📄 License

Licensed under the [MIT License](../../LICENSE).

