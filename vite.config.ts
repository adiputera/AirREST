import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

export default defineConfig(({ mode }) => {
  const isOffline = mode === 'offline';
  const outDir = isOffline ? 'dist-offline' : 'dist';

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'vite-plugin-extension-manifest',
        closeBundle() {
          const outFullPath = path.resolve(import.meta.dirname, outDir);
          const manifestPath = path.resolve(outFullPath, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (isOffline) {
              manifest.name = 'AirREST - Offline REST & Postman Client';
              manifest.description =
                'Fast, privacy-friendly, 100% offline browser-based API client with Postman collection compatibility, zero CORS blocks, and Intranet support.';
              if (manifest.action) {
                manifest.action.default_title = 'Open AirREST (Offline)';
              }

              // Overwrite icons with emerald-green offline icons
              const offlineIconsDir = path.resolve(import.meta.dirname, 'public/icons-offline');
              const targetIconsDir = path.resolve(outFullPath, 'icons');
              if (fs.existsSync(offlineIconsDir) && fs.existsSync(targetIconsDir)) {
                for (const file of fs.readdirSync(offlineIconsDir)) {
                  fs.copyFileSync(
                    path.resolve(offlineIconsDir, file),
                    path.resolve(targetIconsDir, file)
                  );
                }
              }
            } else {
              manifest.name = 'AirREST - REST & Postman Client';
              manifest.description =
                'Fast browser-based API client with Postman collection compatibility, zero CORS blocks, and Intranet support.';
              if (manifest.action) {
                manifest.action.default_title = 'Open AirREST';
              }
            }
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
          }

          // Clean up unused icons-offline folder from dist / dist-offline if copied by Vite
          const tempOfflineDir = path.resolve(outFullPath, 'icons-offline');
          if (fs.existsSync(tempOfflineDir)) {
            fs.rmSync(tempOfflineDir, { recursive: true, force: true });
          }
        },
      },
    ],
    define: {
      'import.meta.env.VITE_APP_EDITION': JSON.stringify(isOffline ? 'offline' : 'full'),
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
    },
  };
});
