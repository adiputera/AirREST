import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAirrestRuntime, AirrestProvider } from '@airrest/common/runtime';
import { App, dispatchBack, initEarlyTheme } from '@airrest/common/ui';
import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import { tauriAdapter } from './adapters/tauriAdapter';
import { DesktopUpdateBanner } from './components/DesktopUpdateBanner';
import { AndroidUpdateBanner } from './components/AndroidUpdateBanner';
import { nativeDistributionConfig } from './distributionConfig';
import './index.css';

initEarlyTheme();

const androidReleaseRepository = nativeDistributionConfig.updates.androidReleaseRepository;
if (androidReleaseRepository === undefined) {
  throw new Error('Native Android builds require an Android release repository.');
}

const runtime = createAirrestRuntime({
  adapter: __AIRREST_ANDROID__ ? { ...tauriAdapter, platformId: 'android' } : tauriAdapter,
  distributionConfig: nativeDistributionConfig,
});

window.addEventListener('beforeunload', () => {
  runtime.dispose();
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
      {__AIRREST_ANDROID__ ? <AndroidUpdateBanner repo={androidReleaseRepository} /> : <DesktopUpdateBanner />}
      <App />
    </AirrestProvider>
  </React.StrictMode>,
);
