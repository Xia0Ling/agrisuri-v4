/* ============================================================================
 * AgriSuri service worker.
 *
 * Strategy:
 *   - Same-origin app shell: network first, cache fallback (so updates land).
 *   - Third-party libraries: cache first (they are versioned URLs).
 *   - Live data (Supabase, weather, geocoding): never cached. Stale weather or
 *     stale farm records presented as current would be worse than an error.
 * ========================================================================== */

const VERSION = 'agrisuri-v4';

const SHELL = [
  'landing.html',
  'auth.html',
  'index.html',
  'dashboard.html',
  'manifest.json',
  'style/landing.css',
  'style/auth.css',
  'style/app.css',
  'style/staff.css',
  'style/theme.css',
  'style/terms.css',
  'script/lib/core.js',
  'script/i18n.js',
  'script/config.js',
  'script/theme.js',
  'script/util.js',
  'script/demo.js',
  'script/db.js',
  'script/offline.js',
  'script/quality.js',
  'script/ai.js',
  'script/guard.js',
  'script/idle.js',
  'script/terms.js',
  'script/auth.js',
  'script/farmer.js',
  'script/staff.js',
  'assets/AgriSuri_Logo.png',
  'assets/AgriSuri_Favicon.png',
  'assets/apple-touch-icon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/Background_Landscape.png',
  'assets/Background_Portrait.png',
];

const VENDOR = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
];
// TensorFlow.js and Teachable Machine are loaded on demand and cached by the
// cache-first branch below on first use, not precached here.

const NEVER_CACHE = /supabase\.co|roboflow\.com|open-meteo\.com|openstreetmap\.org|nominatim/;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Individual failures must not abort the install (optional models, etc.).
      Promise.allSettled([...SHELL, ...VENDOR].map((url) => cache.add(url))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NEVER_CACHE.test(url.hostname)) return;

  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req, { ignoreSearch: true });
          if (hit) return hit;
          // Only a navigation may fall back to the shell. Returning HTML for a
          // failed script request would surface as a syntax error instead of a
          // clean network failure.
          if (req.mode === 'navigate') {
            const shell = await caches.match('index.html');
            if (shell) return shell;
          }
          return Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
