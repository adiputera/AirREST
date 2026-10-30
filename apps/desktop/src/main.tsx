import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAirrestRuntime, AirrestProvider, App } from '@airrest/common';
import { tauriAdapter } from './adapters/tauriAdapter';
import './index.css';

const runtime = createAirrestRuntime({
  adapter: tauriAdapter,
  edition: 'full',
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AirrestProvider runtime={runtime}>
      <App />
    </AirrestProvider>
  </React.StrictMode>,
);
