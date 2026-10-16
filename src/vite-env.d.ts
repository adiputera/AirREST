/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'full' | 'offline';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
