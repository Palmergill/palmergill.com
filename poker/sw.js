// Poker App Service Worker - Basic caching strategy
const CACHE_NAME = 'poker-app-v13';
const STATIC_ASSETS = [
    '/poker/',
    '/poker/index.html',
    '/poker/app.js?v=10',
    '/poker/manifest.json'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .catch((err) => {
                console.error('[SW] Failed to cache assets:', err);
            })
    );

    // Activate immediately
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');

    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Claiming clients');
                return self.clients.claim();
            })
    );
});

// Fetch event - cache-first strategy for static assets, network for API
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // API requests - network only with timeout
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .catch((error) => {
                    console.error('[SW] API fetch failed:', error);
                    // Return a custom offline response for API calls
                    return new Response(
                        JSON.stringify({
                            error: 'offline',
                            message: 'You are offline. Please check your connection.'
                        }),
                        {
                            status: 503,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    );
                })
        );
        return;
    }

    // Navigation requests should prefer the network so design updates are visible
    // immediately, with the cached poker shell as an offline fallback.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((networkResponse) => {
                    if (networkResponse.ok) {
                        const requestClone = networkResponse.clone();
                        const shellClone = networkResponse.clone();
                        caches.open(CACHE_NAME)
                            .then((cache) => {
                                cache.put(request, requestClone);
                                if (url.pathname === '/poker/' || url.pathname === '/poker/index.html') {
                                    cache.put('/poker/index.html', shellClone);
                                }
                            });
                    }
                    return networkResponse;
                })
                .catch((error) => {
                    console.error('[SW] Navigation fetch failed:', error);
                    return caches.match('/poker/index.html');
                })
        );
        return;
    }

    // Static assets - cache first, then network
    event.respondWith(
        caches.match(request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    // Return cached version but also fetch updated version in background
                    fetch(request)
                        .then((networkResponse) => {
                            if (networkResponse.ok) {
                                caches.open(CACHE_NAME)
                                    .then((cache) => {
                                        cache.put(request, networkResponse.clone());
                                    });
                            }
                        })
                        .catch(() => {
                            // Network failed, cached version is fine
                        });
                    return cachedResponse;
                }

                // Not in cache, fetch from network
                return fetch(request)
                    .then((networkResponse) => {
                        // Cache successful responses
                        if (networkResponse.ok) {
                            const responseClone = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(request, responseClone);
                                });
                        }
                        return networkResponse;
                    })
                    .catch((error) => {
                        console.error('[SW] Fetch failed:', error);
                        // For navigation requests, return the cached index.html (SPA fallback)
                        if (request.mode === 'navigate') {
                            return caches.match('/poker/index.html');
                        }
                        throw error;
                    });
            })
    );
});

// Handle messages from the main thread
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
