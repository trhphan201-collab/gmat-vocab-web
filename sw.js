const CACHE_VERSION = "v3";               // <-- mỗi lần update logic/data, tăng v3 -> v4
const CACHE_NAME = `gmat-vocab-${CACHE_VERSION}`;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./vocab.csv",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting(); // dùng SW mới ngay
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)))
    )
  );
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    return cached || Promise.reject(err);
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((fresh) => {
      cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);
  return cached || fetchPromise;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // chỉ handle GET
  if (req.method !== "GET") return;

  // Network-first cho data & code để khỏi bị kẹt bản cũ
  if (url.pathname.endsWith("/app.js") || url.pathname.endsWith("/vocab.csv")) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Với các file còn lại: vừa nhanh vừa tự update
  event.respondWith(staleWhileRevalidate(req));
});
