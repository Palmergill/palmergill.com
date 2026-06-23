// Craps Strategy Simulator service worker — cache-first shell, network-first
// navigations. Mirrors /craps/sw.js. ?v= bumps invalidate the cache via the
// derived cache name.
const CACHE_PREFIX = 'craps-strategy-';
const STATIC_ASSETS = [
    '/craps-strategy/',
    '/craps-strategy/index.html',
    '/craps-strategy/app.js?v=2',
    '/craps-strategy/style.css?v=1',
    '/craps-strategy/strategy.js?v=2',
    '/craps-strategy/engine.js?v=2',
    '/craps-strategy/manifest.json',
    '/craps/crapsRules.js?v=2',
    '/shared/casino-theme.css?v=1',
    '/shared/site-nav.css?v=10',
    '/shared/site-nav.js?v=10',
    '/shared/api-base.js?v=1'
];

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

    // Never cache API calls (the translate endpoint must hit the network).
    if (url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((res) => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put('/craps-strategy/index.html', clone));
                    }
                    return res;
                })
                .catch(() => caches.match('/craps-strategy/index.html'))
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
        caches.match(request).then((cached) => cached || fetch(request))
    );
});
