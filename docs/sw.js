// 집 알림 서비스 워커: 항상 최신 데이터를 먼저 받고, 인터넷이 안 되면 마지막 저장본을 보여줘요.
const CACHE = "house-alert-v4";
const SHELL = ["./", "index.html", "data.json", "rates.json", "keys.js", "map.js", "finance.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        const key = new URL(req.url); key.search = "";   // data.json?t=... 를 하나로 저장
        caches.open(CACHE).then(c => c.put(key.href, copy));
      }
      return res;
    }).catch(() => {
      const key = new URL(req.url); key.search = "";
      return caches.match(key.href).then(r => r || caches.match("index.html"));
    })
  );
});
