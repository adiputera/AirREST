import React from 'react';
import ReactDOM from 'react-dom/client';
import { createAirrestRuntime, AirrestProvider } from '@airrest/common/runtime';
import { App, dispatchBack, initEarlyTheme } from '@airrest/common/ui';
import { exit, onBackButtonPress } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
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
} else {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || '';
  const isAppleDesktop = /Mac|iPod|iPhone|iPad/i.test(platform);
  if (isAppleDesktop) {
    let disposed = false;
    let unlistenCloseTab: (() => void) | null = null;
    const cleanupCloseTabListener = () => {
      disposed = true;
      if (unlistenCloseTab) {
        unlistenCloseTab();
        unlistenCloseTab = null;
      }
      (
        window as Window & { __AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__?: boolean }
      ).__AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__ = false;
    };

    void listen('airrest:close-active-tab', () => {
      window.dispatchEvent(new CustomEvent('airrest:close-active-tab'));
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenCloseTab = unlisten;
        (
          window as Window & { __AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__?: boolean }
        ).__AIRREST_MAC_NATIVE_CLOSE_TAB_MENU__ = true;
      })
      .catch((error) => console.error('Unable to register native close-tab menu listener:', error));

    window.addEventListener('beforeunload', cleanupCloseTabListener, { once: true });
    const hot = (import.meta as ImportMeta & { hot?: { dispose: (cb: () => void) => void } }).hot;
    hot?.dispose(() => {
      window.removeEventListener('beforeunload', cleanupCloseTabListener);
      cleanupCloseTabListener();
    });
  }
}

void runtime.credentialReady.finally(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <AirrestProvider runtime={runtime}>
        {__AIRREST_ANDROID__ ? <AndroidUpdateBanner repo={androidReleaseRepository} /> : <DesktopUpdateBanner />}
        <App />
      </AirrestProvider>
    </React.StrictMode>,
  );
});
