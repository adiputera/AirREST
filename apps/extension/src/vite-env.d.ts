/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'full' | 'offline' | 'cloud';
  readonly VITE_AIRREST_EDITION?: 'full' | 'offline' | 'cloud';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
