import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAirrestRuntime, AirrestProvider } from '@airrest/common';
import { chromeAdapter } from './adapters/chromeAdapter';
import App from './App';
import './index.css';

const edition = ((import.meta.env.VITE_AIRREST_EDITION || import.meta.env.VITE_APP_EDITION || 'full') as 'offline' | 'full');

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
