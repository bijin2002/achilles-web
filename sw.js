/**
 * NexHuman Labs service worker.
 *
 * Strategy is deliberately conservative:
 * - Never cache API/auth traffic (Supabase, OpenAI) — stale auth or stale
 *   nutrition data is worse than being offline.
 * - Static build assets are content-hashed by Expo, so cache-first is safe.
 * - Navigations use network-first with an offline fallback so a deploy is
 *   picked up immediately rather than serving a stale shell.
 */
const VERSION = 'nexhuman-v4';
const STATIC_CACHE = `${VERSION}-static`;
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll([SHELL, '/manifest.webmanifest']))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then((clients) => {
          for (const client of clients) {
            // Force a one-time reload so stale tabs pick up the new bundles
            // even if their running JS has no auto-updater.
            if ('navigate' in client) client.navigate(client.url).catch(() => {});
          }
        }),
      )
      .catch(() => self.clients.claim()),
  );
});

// Let the page trigger immediate activation of a waiting worker.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// --- Web Push: daily "come back and train" reminder ------------------------
// The edge sender posts JSON { title, body, url, icon }. Everything is optional
// except that a notification MUST be shown (userVisibleOnly subscriptions).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  const title = data.title || 'Time to train';
  const options = {
    body: data.body || 'Your session is ready — two minutes to start.',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.tag || 'daily-training-reminder',
    renotify: false,
    data: { url: data.url || '/train' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || '/train';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            if ('navigate' in client) client.navigate(target).catch(() => {});
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
        return undefined;
      }),
  );
});

function isCacheableAsset(url) {
  return (
    url.origin === self.location.origin &&
    /\/_expo\/static\/|\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|ico)$/.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept API / auth / analytics — always hit the network.
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:auth|functions|rest|realtime)\//.test(url.pathname)) return;

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed static assets: cache-first.
  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          }),
      ),
    );
  }
});
