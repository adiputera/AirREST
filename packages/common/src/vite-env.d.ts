/// <reference types="vite/client" />

declare const __AIRREST_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'full' | 'offline' | 'cloud';
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
