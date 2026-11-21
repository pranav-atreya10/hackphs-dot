/* SkySentry static-shell Service Worker.
   Strictly caches same-origin static UI shell assets only; never intercepts live API,
   WebSocket/Socket.IO, health/readiness probes, media clips, AI model weights, or authenticated requests. */
'use strict';

const CACHE_PREFIX = 'skysentry-shell-';
const CACHE_NAME = 'skysentry-shell-v1';

const PRECACHE_URLS = Object.freeze([
  '/app.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/css/app-hub.css',
  '/css/view-transitions.css',
  '/css/smooth-details.css',
  '/css/perf-scroll.css',
  '/js/theme.js',
  '/js/pwa-install.mjs',
  '/brand/favicon.svg',
  '/brand/favicon-32.png',
  '/brand/apple-touch-icon.png',
]);

const BYPASS_HEADER_NAMES = ['authorization', 'x-api-key', 'range'];

const BYPASS_PATH_PREFIXES = [
  '/api',
  '/socket.io',
  '/health',
  '/ready',
  '/clips',
  '/promo',
  '/ai-models',
  '/detection/models',
];

const HEAVY_MEDIA_EXT_RE = /\.(?:mp4|webm|mov|m4v|mp3|wav|ogg|glb|gltf|hdr|wasm|bin|onnx|pb)$/i;
const STATIC_SHELL_ASSET_RE = /^(?:\/manifest\.webmanifest|\/(?:css|js|brand|vendor)\/[^?#]+\.(?:css|js|mjs|svg|png|jpg|jpeg|webp|ico|webmanifest)|\/[^/?#]+\.(?:svg|png|ico))$/i;

function resolveSelfOrigin(explicitOrigin) {
  if (typeof explicitOrigin === 'string' && explicitOrigin.trim()) {
    try {
      return new URL(explicitOrigin).origin;
    } catch {
      // Fall through to self.location
    }
  }
  if (typeof self !== 'undefined' && self && self.location && typeof self.location.origin === 'string') {
    return self.location.origin;
  }
  return 'https://skysentry.local';
}

function hasSensitiveBypassHeader(headers) {
  if (!headers || typeof headers !== 'object') return false;

  if (typeof headers.get === 'function') {
    for (const name of BYPASS_HEADER_NAMES) {
      const val = headers.get(name) ?? headers.get(name.toUpperCase());
      if (typeof val === 'string' && val.trim().length > 0) return true;
    }
  }

  if (typeof headers.has === 'function') {
    for (const name of BYPASS_HEADER_NAMES) {
      if (headers.has(name) || headers.has(name.toUpperCase())) return true;
    }
  }

  if (typeof headers[Symbol.iterator] === 'function') {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const key = String(entry[0] || '').trim().toLowerCase();
        const val = String(entry[1] ?? '').trim();
        if (BYPASS_HEADER_NAMES.includes(key) && val.length > 0) return true;
      }
    }
  }

  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = String(rawKey).trim().toLowerCase();
    if (BYPASS_HEADER_NAMES.includes(key) && rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '') {
      return true;
    }
  }

  return false;
}

function matchesBypassPath(pathname) {
  const normalized = String(pathname || '/').toLowerCase();
  if (normalized === '/sw.js') return true;
  if (HEAVY_MEDIA_EXT_RE.test(normalized)) return true;

  for (const prefix of BYPASS_PATH_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function shouldBypassServiceWorker(requestOrUrl, selfOrigin) {
  if (!requestOrUrl) return true;

  const baseOrigin = resolveSelfOrigin(selfOrigin);
  let rawUrl = '';

  if (typeof requestOrUrl === 'string') {
    rawUrl = requestOrUrl;
  } else if (requestOrUrl instanceof URL) {
    rawUrl = requestOrUrl.href;
  } else if (typeof requestOrUrl === 'object') {
    const method = requestOrUrl.method ? String(requestOrUrl.method).toUpperCase() : 'GET';
    if (method !== 'GET') return true;

    if (requestOrUrl.cache === 'only-if-cached' && requestOrUrl.mode && requestOrUrl.mode !== 'same-origin') {
      return true;
    }

    if (hasSensitiveBypassHeader(requestOrUrl.headers)) {
      return true;
    }

    rawUrl = typeof requestOrUrl.url === 'string' ? requestOrUrl.url : '';
  }

  if (!rawUrl) return true;

  let parsed;
  try {
    parsed = new URL(rawUrl, baseOrigin);
  } catch {
    return true;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }

  if (parsed.origin !== baseOrigin) {
    return true;
  }

  if (matchesBypassPath(parsed.pathname)) {
    return true;
  }

  return false;
}

function getHeaderValue(headers, targetName) {
  if (!headers || typeof headers !== 'object') return '';
  const lower = targetName.toLowerCase();
  if (typeof headers.get === 'function') {
    return String(headers.get(lower) ?? headers.get(targetName) ?? '');
  }
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v ?? '');
  }
  return '';
}

function isHtmlNavigationRequest(request, parsedUrl) {
  if (request && typeof request === 'object') {
    if (request.mode === 'navigate' || request.destination === 'document') return true;
    const accept = getHeaderValue(request.headers, 'accept').toLowerCase();
    if (accept.includes('text/html')) return true;
  }
  const pathname = parsedUrl ? parsedUrl.pathname.toLowerCase() : '';
  return pathname === '/' || pathname.endsWith('.html');
}

function isStaticShellAsset(pathname) {
  return STATIC_SHELL_ASSET_RE.test(String(pathname || ''));
}

function isCacheableResponse(response) {
  if (!response || response.status !== 200) return false;
  if (response.type && response.type !== 'basic' && response.type !== 'default') return false;
  const cacheControl = getHeaderValue(response.headers, 'cache-control');
  if (/\b(?:no-store|private)\b/i.test(cacheControl)) return false;
  return true;
}

function cloneResponseSafe(response) {
  return response && typeof response.clone === 'function' ? response.clone() : response;
}

async function precacheShellAssets() {
  if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return;
  const cache = await caches.open(CACHE_NAME);

  await Promise.allSettled(
    PRECACHE_URLS.map(async (assetUrl) => {
      if (typeof fetch === 'function') {
        const req = typeof Request === 'function' ? new Request(assetUrl, { cache: 'no-cache' }) : assetUrl;
        const response = await fetch(req);
        if (isCacheableResponse(response) && typeof cache.put === 'function') {
          await cache.put(assetUrl, cloneResponseSafe(response));
        }
      } else if (typeof cache.add === 'function') {
        await cache.add(assetUrl);
      }
    })
  );

  if (typeof self !== 'undefined' && self && typeof self.skipWaiting === 'function') {
    await self.skipWaiting();
  }
}

async function cleanupOldShellCaches() {
  if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => typeof key === 'string' && key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
  }

  if (typeof self !== 'undefined' && self && self.clients && typeof self.clients.claim === 'function') {
    await self.clients.claim();
  }
}

async function handleNavigationFetch(request, parsedUrl) {
  const cache = typeof caches !== 'undefined' && caches ? await caches.open(CACHE_NAME) : null;

  try {
    const networkResponse = await fetch(request);
    if (cache && isCacheableResponse(networkResponse) && typeof cache.put === 'function') {
      await cache.put(parsedUrl.pathname, cloneResponseSafe(networkResponse));
    }
    return networkResponse;
  } catch (err) {
    if (cache && typeof cache.match === 'function') {
      const exact = (await cache.match(request)) || (await cache.match(parsedUrl.pathname));
      if (exact) return exact;
      const appShell = await cache.match('/app.html');
      if (appShell) return appShell;
    }
    throw err;
  }
}

async function handleStaticShellFetch(event, request, parsedUrl) {
  const cache = typeof caches !== 'undefined' && caches ? await caches.open(CACHE_NAME) : null;
  const cached =
    cache && typeof cache.match === 'function'
      ? (await cache.match(request)) || (await cache.match(parsedUrl.pathname))
      : null;

  const revalidatePromise = Promise.resolve()
    .then(() => fetch(request))
    .then(async (networkResponse) => {
      if (cache && isCacheableResponse(networkResponse) && typeof cache.put === 'function') {
        await cache.put(parsedUrl.pathname, cloneResponseSafe(networkResponse));
      }
      return networkResponse;
    });

  if (cached) {
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(revalidatePromise.catch(() => {}));
    } else {
      revalidatePromise.catch(() => {});
    }
    return cached;
  }

  return revalidatePromise;
}

if (typeof self !== 'undefined' && self && typeof self.addEventListener === 'function') {
  self.addEventListener('install', (event) => {
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(precacheShellAssets());
    }
  });

  self.addEventListener('activate', (event) => {
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(cleanupOldShellCaches());
    }
  });

  self.addEventListener('fetch', (event) => {
    const request = event && event.request;
    const selfOrigin = resolveSelfOrigin();
    if (shouldBypassServiceWorker(request, selfOrigin)) {
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(request.url, selfOrigin);
    } catch {
      return;
    }

    if (isHtmlNavigationRequest(request, parsedUrl)) {
      event.respondWith(handleNavigationFetch(request, parsedUrl));
      return;
    }

    if (isStaticShellAsset(parsedUrl.pathname)) {
      event.respondWith(handleStaticShellFetch(event, request, parsedUrl));
    }
  });
}

const swExports = {
  CACHE_NAME,
  CACHE_PREFIX,
  PRECACHE_URLS,
  shouldBypassServiceWorker,
  isHtmlNavigationRequest,
  isStaticShellAsset,
  precacheShellAssets,
  cleanupOldShellCaches,
};

if (typeof self !== 'undefined' && self) {
  self.shouldBypassServiceWorker = shouldBypassServiceWorker;
  self.__SKYSENTRY_SW__ = swExports;
}

if (typeof globalThis !== 'undefined' && globalThis) {
  globalThis.shouldBypassServiceWorker = shouldBypassServiceWorker;
  globalThis.__SKYSENTRY_SW__ = swExports;
}

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = swExports;
}
