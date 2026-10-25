// Cache recent network error codes from Chrome network stack
const recentNetworkErrors = new Map();

if (typeof chrome !== 'undefined' && chrome.webRequest?.onErrorOccurred) {
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      // Keep last 100 failed requests with timestamp
      recentNetworkErrors.set(details.url, {
        error: details.error,
        timestamp: Date.now(),
      });

      // Purge entries older than 30s
      const cutoff = Date.now() - 30000;
      for (const [url, entry] of recentNetworkErrors.entries()) {
        if (entry.timestamp < cutoff) {
          recentNetworkErrors.delete(url);
        }
      }
    },
    { urls: ['<all_urls>'] }
  );

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'GET_RECENT_NETWORK_ERROR') {
      const entry = recentNetworkErrors.get(message.url);
      sendResponse({ error: entry ? entry.error : null });
    }
  });
}

chrome.action.onClicked.addListener(async () => {
  try {
    const extensionUrl = chrome.runtime.getURL('index.html');
    const tabs = await chrome.tabs.query({ url: extensionUrl });

    if (tabs.length > 0 && tabs[0]?.id) {
      // Focus existing tab
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
    } else {
      // Open new tab
      await chrome.tabs.create({ url: extensionUrl });
    }
  } catch (err) {
    console.error('Failed to open or focus extension tab:', err);
  }
});
