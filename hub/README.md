# AirREST Hub
 
> Full-page workspace and team administration portal for AirREST. Built with **React 19**, **Vite**, **Tailwind CSS v4**, and **Zustand**.
 
---
 
## 🚀 Overview
 
AirREST Hub is the companion web dashboard for managing collaboration in AirREST:
- **Teams & Member Roles**: Create, edit (name & description), and delete teams (Superadmin only) with interactive confirmation dialogs, invite multiple users simultaneously using interactive checkboxes with live search and select-all, and assign Team Admin and Member roles.
- **Project Isolation**: Create, edit (name & description), and delete projects (Project Admins & Superadmins) with interactive confirmation dialogs, and assign members in batch with granular RBAC permissions (`Admin`, `Maintainer`, `Contributor`, `Reader`).
- **Project Collections & Environments**: View synchronized collection requests (clean read-only title list) and environment variables, with granular minimum-role access permissions (`admin`, `maintainer`, `contributor`, `reader`) configurable directly per collection and environment.
- **Action Confirmations**: Interactive confirmation dialogs require explicit confirmation before deleting teams, projects, or removing members.
- **Superadmin Panel**: System-level administrative tools to manage all registered users, provision system accounts, reset passwords, and permanently remove user accounts with automatic entity reassignment.
- **Decoupled Architecture**: Runs entirely independent of the Chrome extension, keeping the extension bundle ultra-lightweight.
 
---
 
## ⚙️ Environment & Security
 
- **Optional Default API URL (`VITE_API_URL`)**: You can set an optional default backend URL in `.env` or Vercel Environment Variables (`VITE_API_URL=https://your-backend.vercel.app`). If omitted, Hub defaults to `http://localhost:8080`.
- **No Client Secrets Required**: AirREST Hub connects to the AirREST Go backend dynamically via user configuration. No backend database credentials or server secrets exist in this client bundle.
- **Client Storage**: User credentials, tokens, and active backend API URLs are securely stored in the browser's `localStorage` via Zustand Persist.
- **Zero Corporate Data**: Adheres strictly to personal open-source privacy standards without corporate infrastructure references.
 
---
 
## 🛠 Local Development
 
From the repository root:
 
```bash
# Start Hub in development mode (http://localhost:5173)
npm run dev:hub
 
# Build Hub for production (hub/dist/)
npm run build:hub
```
 
Or directly inside `hub/`:
 
```bash
cd hub
npm run dev
npm run build
```
 
---
 
## ▲ Deploying to Vercel
 
AirREST Hub deploys seamlessly to Vercel as a single-page application:
 
1. In the [Vercel Dashboard](https://vercel.com/dashboard), import the repository.
2. Set **Root Directory** to **`hub`**.
3. Framework Preset: **Vite**.
4. *(Optional)* Set **Environment Variables**: `VITE_API_URL` with your deployed backend URL (e.g. `https://airrest-backend.vercel.app`).
5. Single-page application route rewrites are pre-configured in `hub/vercel.json`.
6. Click **Deploy**!
 
---
 
## 📄 License
 
Licensed under the [MIT License](../LICENSE).
