import React from 'react';
import ReactDOM from 'react-dom/client';
import { initEarlyTheme } from '@airrest/common/ui';
import {
  createAirrestRuntime,
  AirrestProvider,
  parseProductEdition,
} from '@airrest/common/runtime';
import { chromeAdapter } from './adapters/chromeAdapter';
import App from './App';
import './index.css';

initEarlyTheme();

const edition = parseProductEdition(import.meta.env.VITE_AIRREST_EDITION || import.meta.env.VITE_APP_EDITION || 'full');

const runtime = createAirrestRuntime({
  adapter: chromeAdapter,
  edition,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AirrestProvider runtime={runtime}>
      <App />
    </AirrestProvider>
  </React.StrictMode>
);
