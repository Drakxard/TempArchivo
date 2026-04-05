const CACHE_VERSION = "temp-archivo-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableStaticAsset(requestUrl) {
  return (
    requestUrl.origin === self.location.origin &&
    (requestUrl.pathname.startsWith("/_next/static/") ||
      requestUrl.pathname.startsWith("/icons/") ||
      requestUrl.pathname === "/manifest.json")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }

  if (
    requestUrl.origin === self.location.origin &&
    requestUrl.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        return cache.match("/") || Response.error();
      }),
    );
    return;
  }

  if (!isCacheableStaticAsset(requestUrl)) {
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cachedResponse) => {
      const networkResponsePromise = fetch(request)
        .then(async (networkResponse) => {
          if (networkResponse.ok) {
            const cache = await caches.open(CACHE_VERSION);
            await cache.put(request, networkResponse.clone());
          }

          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkResponsePromise;
    }),
  );
});
