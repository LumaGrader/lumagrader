// LumaGrader web editor (/editor/) offline support. Photos never touch the network (they stay in the browser), so
// caching the app itself is enough to edit with no signal once the app was opened online.
//  - Page (navigation): network-first → always picks up new deploys; cached copy offline.
//  - /assets/* (hashed, immutable): cache-first.
//  - Other same-origin files (icons, manifest): stale-while-revalidate.
const SHELL = 'lumagrader-editor-shell-v1' // bump when icons or the manifest change
const ASSETS = 'lumagrader-editor-assets'
const MAX_ASSETS = 80
const SHELL_FILES = ['./', './index.html', './manifest.webmanifest', '../favicon-32.png', '../icon-192.png']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lumagrader-editor-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i])
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(SHELL).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true })),
    )
    return
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(ASSETS).then((c) => c.put(req, copy).then(() => trim(ASSETS, MAX_ASSETS)))
            }
            return res
          }),
      ),
    )
    return
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(SHELL).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => hit || Response.error())
      return hit || network
    }),
  )
})
