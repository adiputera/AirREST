/**
 * Distribution edition helper for AirREST.
 *
 * Supports multi-target builds from a single codebase:
 * - 'offline': 100% offline-only build for Chrome Web Store public release.
 * - 'full': Default edition with offline capabilities + cloud workspace sync.
 */
export const APP_EDITION = (import.meta.env.VITE_APP_EDITION as string) || 'full';
export const isOfflineOnly = APP_EDITION === 'offline';
