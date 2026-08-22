// High Card Flush service worker — app shell offline, navigations network first.
const CACHE_PREFIX = 'high-card-flush-app-';
const STATIC_ASSETS = [
    '/high-card-flush/',
    '/high-card-flush/index.html',
    '/high-card-flush/app.js?v=2',
    '/high-card-flush/highCardFlushGame.js?v=1',
    '/high-card-flush/style.css?v=1',
    '/high-card-flush/manifest.json',
    '/shared/casino-theme.css?v=3',
    '/shared/rules-viewer.css?v=1',
    '/shared/rules-viewer.js?v=1',
    '/shared/casino-profile.js?v=3',
    '/shared/casino-header.js?v=2',
    '/shared/analytics.js?v=1',
    '/shared/site-nav.css?v=13',
    '/shared/site-nav.js?v=14',
    '/casino/high%20card%20flush%20rules%20and%20strategy.txt'
];

function buildCacheName(prefix, assets) {
    let hash = 5381;
    const joined = assets.join('|');
    for (let i = 0; i < joined.length; i += 1) {
        hash = ((hash << 5) + hash + joined.charCodeAt(i)) >>> 0;
    }
    return `${prefix}${hash.toString(36)}`;
}

const CACHE_NAME = buildCacheName(CACHE_PREFIX, STATIC_ASSETS);

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .catch((error) => console.error('[High Card Flush] Cache install failed:', error))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
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
                .then((response) => {
                    if (response.ok) {
                        caches.open(CACHE_NAME).then((cache) => cache.put('/high-card-flush/index.html', response.clone()));
                    }
                    return response;
                })
                .catch(() => caches.match('/high-card-flush/index.html'))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response.ok && url.origin === self.location.origin) {
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
                }
                return response;
            });
            if (cached) {
                network.catch(() => {});
                return cached;
            }
            return network;
        })
    );
});
