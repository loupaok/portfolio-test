const CACHE_NAME = 'pwa-cache-v1768815534464';
const PRECACHE_URLS = ["/"];

// Check if a client is running as installed PWA (standalone mode)
async function isStandaloneMode() {
    const clients = await self.clients.matchAll({ type: 'window' });
    // If any client is in standalone mode, enable caching
    // We check via a message since we can't directly check display-mode from SW
    return clients.length > 0 && self.isStandalone;
}

// Listen for messages from the app to know if we're in standalone mode
self.isStandalone = false;
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SET_STANDALONE') {
        self.isStandalone = event.data.isStandalone;
        // Pre-cache pages when app is installed
        if (self.isStandalone) {
            caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS));
        }
    }
});

self.addEventListener('install', (event) => {
    // Skip waiting to activate immediately
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Only intercept requests when running as installed app
    if (!self.isStandalone) return;
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;
    if (event.request.url.includes('/api/')) return;
    event.respondWith(handleFetch(event.request));
});

async function handleFetch(request) {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
        // Update cache in background
        fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
        }).catch(() => {});
        return cachedResponse;
    }
    
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) cache.put(request, networkResponse.clone());
        return networkResponse;
    } catch (error) {
        // Return cached homepage as fallback for navigation requests
        if (request.mode === 'navigate') {
            const homePage = await cache.match('/');
            if (homePage) return homePage;
        }
        throw error;
    }
}
