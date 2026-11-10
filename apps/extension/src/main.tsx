import React from 'react';
import ReactDOM from 'react-dom/client';
import { initEarlyTheme } from '@airrest/common/ui';
import { createApplicationDistributionConfig } from '@airrest/common/configuration';
import {
  createAirrestRuntime,
  AirrestProvider,
} from '@airrest/common/runtime';
import { chromeAdapter } from './adapters/chromeAdapter';
import App from './App';
import './index.css';

initEarlyTheme();

const extensionDistributionConfig = createApplicationDistributionConfig({
  auth: { providerId: 'password' },
  workspace: { edition: import.meta.env.VITE_AIRREST_EDITION || import.meta.env.VITE_APP_EDITION || 'full' },
});

const runtime = createAirrestRuntime({
  adapter: chromeAdapter,
  distributionConfig: extensionDistributionConfig,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AirrestProvider runtime={runtime}>
      <App />
    </AirrestProvider>
  </React.StrictMode>
);
