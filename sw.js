/* Foodly! — сервис-воркер: precache оболочки + stale-while-revalidate для CDN */
'use strict';
var VERSION = 'foodly-v1.4.0';
var PRECACHE = VERSION + '-precache';
var RUNTIME = VERSION + '-runtime';
var IMAGES = 'foodly-images';        // фото по ссылкам: не версионируется, чтобы не терять их при обновлении
var IMAGES_MAX = 150;
var APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'fonts/Geist-Regular.woff',
  'fonts/Geist-Medium.woff',
  'fonts/Geist-SemiBold.woff',
  'fonts/Geist-Bold.woff',
  'fonts/geist-pdf.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];
/* Библиотеки CDN кладём в кеш заранее (если сеть есть), чтобы PDF работал офлайн */
var CDN_WARM = [
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.3/Sortable.min.js'
];
var RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(PRECACHE).then(function (cache) { return cache.addAll(APP_FILES); }).then(function () {
      return caches.open(RUNTIME).then(function (cache) {
        return Promise.all(CDN_WARM.map(function (url) {
          return fetch(url, { mode: 'cors' }).then(function (res) { if (res.ok) return cache.put(url, res); }).catch(function () {});
        }));
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('foodly-') === 0 && k.indexOf(VERSION) !== 0 && k !== IMAGES; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function staleWhileRevalidate(request) {
  return caches.open(RUNTIME).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    });
  });
}

function trimCache(name, max) {
  return caches.open(name).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= max) return;
      return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); }));
    });
  });
}
function cacheImage(request) {
  return caches.open(IMAGES).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(request, res.clone()).then(function () { return trimCache(IMAGES, IMAGES_MAX); }).catch(function () {});
        }
        return res;
      }).catch(function () { return cached || Response.error(); });
      return cached || network;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (RUNTIME_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Фото по внешним ссылкам: stale-while-revalidate + ограничение на число записей
  if (req.destination === 'image' && url.origin !== self.location.origin && (url.protocol === 'https:' || url.protocol === 'http:')) {
    event.respondWith(cacheImage(req));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Навигация: сеть → кеш (офлайн отдаём оболочку)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(PRECACHE).then(function (c) { c.put('index.html', copy); });
        return res;
      }).catch(function () { return caches.match('index.html', { ignoreSearch: true }); })
    );
    return;
  }
  // Файлы приложения: cache-first с обновлением в фоне
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) { var copy = res.clone(); caches.open(PRECACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
