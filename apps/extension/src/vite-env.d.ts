/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'full' | 'offline';
  readonly VITE_AIRREST_EDITION?: 'full' | 'offline';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
