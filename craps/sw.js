// Craps Service Worker — cache-first for app shell, network-first for navigations.
const CACHE_PREFIX = 'craps-app-';
const STATIC_ASSETS = [
    '/craps/',
    '/craps/index.html',
    '/craps/app.js?v=8',
    '/craps/style.css?v=1',
    '/craps/crapsRules.js?v=1',
    '/craps/manifest.json',
    '/shared/casino-theme.css?v=1',
    '/shared/rules-viewer.css?v=1',
    '/shared/rules-viewer.js?v=1',
    '/shared/casino-profile.js?v=1',
    '/shared/site-nav.css?v=9',
    '/shared/site-nav.js?v=10',
    '/casino/craps%20rules%20and%20odds.txt'
];

// Derive the cache name from the asset list so any ?v= bump invalidates
// the previous cache automatically.
function buildCacheName(prefix, assets) {
    let hash = 5381;
    const joined = assets.join('|');
    for (let i = 0; i < joined.length; i++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(i)) >>> 0;
    }
    return `${prefix}${hash.toString(36)}`;
}
const CACHE_NAME = buildCacheName(CACHE_PREFIX, STATIC_ASSETS);

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

    if (['script', 'style', 'worker'].includes(request.destination) || /\.(js|css)$/.test(url.pathname)) {
        event.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok && url.origin === self.location.origin) {
                        caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
                    }
                    return res;
                })
                .catch(() => caches.match(request))
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
