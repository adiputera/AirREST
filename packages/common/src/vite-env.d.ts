/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'full' | 'offline';
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
