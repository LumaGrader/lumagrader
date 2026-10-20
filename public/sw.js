// Retired service worker. Until 2026-10 the web editor lived at the site root and installed a
// service worker here (scope "/"). The editor now lives at /editor/ with its own worker, and the
// root is the download site. Browsers fetch this file when they check the old worker for updates;
// this version clears the old caches and unregisters itself, so the home page is never served
// from a stale editor cache. Photos/projects (IndexedDB, localStorage) are not touched.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k.startsWith('lumagrader-shell-') || k === 'lumagrader-assets').map((k) => caches.delete(k)),
      )
      await self.registration.unregister()
    })(),
  )
})
