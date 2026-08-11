/*
 * The dashboard's service worker. It caches nothing, on purpose.
 *
 * Why it exists at all: Chrome dropped the service-worker requirement for
 * installing from the browser menu (v108 mobile, v112 desktop), but the
 * algorithm that fires `beforeinstallprompt` still requires a fetch handler.
 * Without one there is no in-app Install button, and a seller has to find the
 * browser menu themselves — which, standing behind a counter, they will not.
 *
 * Why it caches nothing: the dashboard is a live order queue. Every screen in
 * it is worth less than nothing when stale — a cached queue shows an order as
 * unconfirmed that the seller confirmed an hour ago. Offline support here is a
 * feature request, not a default, and a caching service worker installed by
 * accident is the hardest kind of bug to talk a client through.
 *
 * So: a real fetch handler, on navigations only, straight to the network.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});
