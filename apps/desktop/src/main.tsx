import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAirrestRuntime, AirrestProvider, App, dispatchBack } from '@airrest/common';
import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import { tauriAdapter } from './adapters/tauriAdapter';
import { DesktopUpdateBanner } from './components/DesktopUpdateBanner';
import { AndroidUpdateBanner } from './components/AndroidUpdateBanner';
import './index.css';

const runtime = createAirrestRuntime({
  adapter: __AIRREST_ANDROID__ ? { ...tauriAdapter, platformId: 'android' } : tauriAdapter,
  edition: 'full',
});

if (__AIRREST_ANDROID__) {
  void onBackButtonPress(({ canGoBack }) => {
    if (dispatchBack()) return;
    if (canGoBack) window.history.back();
    else void exit(0);
  }).catch((error) => console.error('Unable to register Android Back handler:', error));
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AirrestProvider runtime={runtime}>
      {__AIRREST_ANDROID__ ? <AndroidUpdateBanner /> : <DesktopUpdateBanner />}
      <App />
    </AirrestProvider>
  </React.StrictMode>,
);
