/*
 * 임장 체크리스트 — 서비스 워커
 * - 앱 파일을 모두 미리 저장해 두고(사전 캐시), 저장된 것을 먼저 쓴다(cache-first).
 *   → 현장에서 인터넷이 약하거나 끊겨도 앱이 열린다.
 * - 파일(data.js 등)을 고치면 아래 CACHE_VERSION 숫자를 올려야 iPhone 에 새 내용이 반영된다.
 *   (이름이 바뀐 새 캐시를 만들고, 예전 캐시는 지운다)
 */
'use strict';

var CACHE_PREFIX = 'imjang-static-';
var CACHE_VERSION = CACHE_PREFIX + 'v1.5.1';

// 사전 캐시 목록 — 실제 파일과 반드시 일치해야 한다(하나라도 없으면 설치 실패)
var PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './import-parser.js',
  './merge.js',
  './app.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// 리다이렉트된 응답은 Safari 가 탐색 응답으로 쓰지 못하므로 깨끗한 응답으로 다시 만든다
function cleanResponse(res) {
  if (!res.redirected) return Promise.resolve(res);
  return res.blob().then(function (body) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return Promise.all(PRECACHE.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
          if (!res.ok) throw new Error('사전 캐시 실패: ' + url + ' (' + res.status + ')');
          return cleanResponse(res).then(function (clean) { return cache.put(url, clean); });
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_VERSION) return caches.delete(key);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 바깥 사이트(인터넷등기소 등)는 건드리지 않음

  // 앱 주소(폴더 주소 또는 index.html)를 열 때는 저장된 index.html 로 (해시 라우팅이라 페이지는 하나).
  // 같은 폴더의 다른 문서(CHECKLIST.md, README.md 등)는 아래 일반 규칙으로 네트워크에서 받는다.
  var scopePath = new URL('./', self.location).pathname;
  var isAppShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
  if (req.mode === 'navigate' && isAppShell) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(function (cache) {
        return cache.match('./index.html').then(function (hit) {
          return hit || cache.match('./').then(function (hit2) { return hit2 || fetch(req); });
        });
      })
    );
    return;
  }

  // 그 밖의 파일: 캐시 먼저, 없으면 네트워크에서 받아 캐시에 넣기
  event.respondWith(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        });
      });
    })
  );
});
