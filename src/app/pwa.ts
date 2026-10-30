/**
 * PWA setup: offline support (service worker) and durable storage.
 */

/** Registers public/sw.js in production builds only (it would cache stale files during development). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Files loaded before the service worker took over (the very first visit)
        // aren't in its cache yet. Hand it the list so the app also opens offline
        // on the next launch.
        const urls = [location.href.split('#')[0]!, ...performance.getEntriesByType('resource').map((e) => e.name)].filter(
          (u) => new URL(u).origin === location.origin,
        );
        reg.active?.postMessage({ type: 'CACHE_URLS', urls });
      })
      .catch((err: unknown) => {
        console.warn('Service worker registration failed', err);
      });
  });
}

/**
 * Asks the browser not to evict this app's data when the device is low on
 * space. Browsers may say no; the export/backup feature is the real safeguard.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
