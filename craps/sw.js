// Craps Service Worker — cache-first for app shell, network-first for navigations.
const CACHE_NAME = 'craps-app-v1';
const CACHE_PREFIX = 'craps-app-';
const STATIC_ASSETS = [
    '/craps/',
    '/craps/index.html',
    '/craps/app.js?v=4',
    '/craps/crapsRules.js?v=1',
    '/craps/manifest.json',
    '/shared/casino-profile.js?v=1',
    '/shared/site-nav.css?v=6',
    '/shared/site-nav.js?v=6'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .catch((err) => { console.error('[SW] Failed to cache assets:', err); })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put('/craps/index.html', clone));
                    }
                    return res;
                })
                .catch(() => caches.match('/craps/index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) {
                fetch(request).then((res) => {
                    if (res.ok) caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
                }).catch(() => {});
                return cached;
            }
            return fetch(request).then((res) => {
                if (res.ok && (url.origin === self.location.origin)) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(request, clone));
                }
                return res;
            });
        })
    );
});
