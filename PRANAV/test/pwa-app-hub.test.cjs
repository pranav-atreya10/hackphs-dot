'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const pranavRoot = path.join(__dirname, '..');
const publicDir = path.join(pranavRoot, 'public');
const manifestPath = path.join(publicDir, 'manifest.webmanifest');
const appHtmlPath = path.join(publicDir, 'app.html');
const swPath = path.join(publicDir, 'sw.js');
const pwaInstallPath = path.join(publicDir, 'js', 'pwa-install.mjs');
const appHubCssPath = path.join(publicDir, 'css', 'app-hub.css');
const { applyPerfStaticHeaders } = require('../perf-headers');

/* ---------- Helpers for Service Worker VM sandbox ---------- */

function createSwSandbox({ origin = 'https://skysentry.example', fetchImpl, initialCaches = {} } = {}) {
  const listeners = new Map();
  const cacheMap = new Map();
  let claimed = false;
  let skippedWaiting = false;

  for (const [cacheName, entries] of Object.entries(initialCaches)) {
    const store = new Map();
    for (const [k, v] of Object.entries(entries)) {
      store.set(k, v);
    }
    cacheMap.set(cacheName, store);
  }

  const normalizeKey = (reqOrUrl) => {
    if (typeof reqOrUrl === 'string') {
      return new URL(reqOrUrl, origin).pathname;
    }
    if (reqOrUrl && typeof reqOrUrl.url === 'string') {
      return new URL(reqOrUrl.url, origin).pathname;
    }
    return String(reqOrUrl);
  };

  const caches = {
    async open(name) {
      if (!cacheMap.has(name)) cacheMap.set(name, new Map());
      const store = cacheMap.get(name);
      return {
        async put(req, res) {
          store.set(normalizeKey(req), res);
        },
        async match(req) {
          return store.get(normalizeKey(req)) || undefined;
        },
        async keys() {
          return [...store.keys()];
        },
      };
    },
    async keys() {
      return [...cacheMap.keys()];
    },
    async delete(name) {
      return cacheMap.delete(name);
    },
  };

  class MockRequest {
    constructor(input, init = {}) {
      if (typeof input === 'object' && input !== null && 'url' in input) {
        this.url = new URL(input.url, origin).href;
        this.method = String(init.method || input.method || 'GET').toUpperCase();
        this.headers = init.headers || input.headers || new Map();
        this.mode = init.mode || input.mode || 'cors';
        this.cache = init.cache || input.cache || 'default';
      } else {
        this.url = new URL(String(input), origin).href;
        this.method = String(init.method || 'GET').toUpperCase();
        this.headers = init.headers || new Map();
        this.mode = init.mode || 'cors';
        this.cache = init.cache || 'default';
      }
    }
  }

  const createResponse = (body, { status = 200, headers = {} } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    body,
    headers: {
      get(name) {
        const lower = String(name).toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
    clone() {
      return createResponse(body, { status, headers });
    },
  });

  const selfObj = {
    location: new URL(`${origin}/sw.js`),
    clients: {
      async claim() {
        claimed = true;
      },
    },
    async skipWaiting() {
      skippedWaiting = true;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
  };

  const sandbox = {
    self: selfObj,
    caches,
    URL,
    Request: MockRequest,
    fetch: fetchImpl || (async (req) => createResponse(`body:${normalizeKey(req)}`)),
    Promise,
    Object,
    String,
    Array,
    Symbol,
  };
  sandbox.globalThis = sandbox;

  const swCode = fs.readFileSync(swPath, 'utf8');
  vm.runInNewContext(swCode, sandbox, { filename: 'sw.js' });

  return {
    sandbox,
    listeners,
    cacheMap,
    MockRequest,
    createResponse,
    get claimed() {
      return claimed;
    },
    get skippedWaiting() {
      return skippedWaiting;
    },
    async dispatchLifecycle(type) {
      const pending = [];
      const handler = listeners.get(type);
      assert.equal(typeof handler, 'function', `Expected ${type} listener in sw.js`);
      handler({
        waitUntil(p) {
          pending.push(Promise.resolve(p));
        },
      });
      await Promise.all(pending);
    },
    dispatchFetch(request) {
      let responsePromise = null;
      const backgroundTasks = [];
      const handler = listeners.get('fetch');
      assert.equal(typeof handler, 'function', 'Expected fetch listener in sw.js');
      handler({
        request,
        respondWith(p) {
          responsePromise = Promise.resolve(p);
        },
        waitUntil(p) {
          backgroundTasks.push(Promise.resolve(p));
        },
      });
      return {
        intercepted: responsePromise !== null,
        responsePromise,
        backgroundTasks,
      };
    },
  };
}

/* ---------- Helpers for App Hub DOM harness ---------- */

function createHubDomHarness({
  url = 'https://airport.example:8443/app.html?apiKey=secret-123#session-token',
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
  platform = 'MacIntel',
  maxTouchPoints = 0,
  standalone = false,
  navStandalone = false,
  onLine = true,
  serviceWorker = {
    async register(swUrl, opts) {
      return { scope: opts?.scope || '/', scriptURL: swUrl };
    },
  },
  QRCode = null,
  qrcode = null,
  clipboardImpl = null,
} = {}) {
  const winListeners = new Map();
  const mqlListeners = new Set();
  const copiedValues = [];

  const makeEl = (tag, initial = {}) => {
    const attrs = new Map(Object.entries(initial.attrs || {}));
    const elListeners = new Map();
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: initial.id || '',
      textContent: initial.textContent || '',
      innerHTML: initial.innerHTML || '',
      hidden: Boolean(initial.hidden),
      disabled: Boolean(initial.disabled),
      dataset: { ...(initial.dataset || {}) },
      style: {},
      setAttribute(k, v) {
        attrs.set(k.toLowerCase(), String(v));
      },
      getAttribute(k) {
        return attrs.get(k.toLowerCase()) ?? null;
      },
      removeAttribute(k) {
        attrs.delete(k.toLowerCase());
      },
      addEventListener(type, fn) {
        if (!elListeners.has(type)) elListeners.set(type, new Set());
        elListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        elListeners.get(type)?.delete(fn);
      },
      async click() {
        for (const fn of [...(elListeners.get('click') || [])]) {
          await fn({ currentTarget: this, target: this });
        }
      },
    };
  };

  const elements = {
    '[data-pwa-sw-status]': makeEl('span', {
      textContent: 'Offline shell: checking…',
      dataset: { state: 'checking' },
      attrs: { 'data-state': 'checking' },
    }),
    '[data-pwa-network-status]': makeEl('span', {
      textContent: 'Network: online',
      dataset: { online: 'true' },
      attrs: { 'data-online': 'true' },
    }),
    '[data-pwa-standalone-badge]': makeEl('span', {
      textContent: 'Standalone active',
      hidden: true,
      attrs: { hidden: '' },
    }),
    '[data-pwa-install]': makeEl('button', {
      textContent: 'Install SkySentry App',
    }),
    '[data-pwa-install-note]': makeEl('p', {
      textContent: 'Checking browser installation support…',
    }),
    '[data-pwa-ios-steps]': makeEl('div', {
      hidden: true,
      attrs: { hidden: '' },
    }),
    '[data-camera-qr]': makeEl('div', {
      innerHTML: '<svg data-fallback="1"></svg>',
    }),
    '[data-camera-url]': makeEl('code', {
      textContent: '/camera.html',
    }),
    '[data-copy-camera-url]': makeEl('button', {
      textContent: 'Copy camera link',
    }),
  };

  const root = {
    nodeType: 1,
    id: 'appHub',
    querySelector(sel) {
      return elements[sel] || null;
    },
  };

  const doc = {
    getElementById(id) {
      return id === 'appHub' ? root : null;
    },
    querySelector(sel) {
      return elements[sel] || null;
    },
  };

  const navigatorObj = {
    userAgent,
    platform,
    maxTouchPoints,
    standalone: navStandalone,
    onLine,
    serviceWorker,
    clipboard:
      clipboardImpl ||
      {
        async writeText(text) {
          copiedValues.push(text);
        },
      },
  };

  let isStandalone = standalone;
  const matchMedia = (query) => ({
    media: query,
    get matches() {
      return query.includes('standalone') ? isStandalone : false;
    },
    addEventListener(type, fn) {
      if (type === 'change') mqlListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'change') mqlListeners.delete(fn);
    },
  });

  const parsedLoc = new URL(url);
  const windowObj = {
    document: doc,
    navigator: navigatorObj,
    location: parsedLoc,
    matchMedia,
    QRCode,
    qrcode,
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    emit(type, event = {}) {
      for (const fn of [...(winListeners.get(type) || [])]) {
        fn(event);
      }
    },
  };

  return {
    window: windowObj,
    document: doc,
    navigator: navigatorObj,
    location: parsedLoc,
    matchMedia,
    root,
    elements,
    copiedValues,
    setStandalone(val) {
      isStandalone = Boolean(val);
      for (const fn of [...mqlListeners]) fn({ matches: isStandalone });
    },
  };
}

/* ========================================================================== *
 *  1. Web App Manifest & Static Header Verification                          *
 * ========================================================================== */

describe('manifest.webmanifest contract', () => {
  test('parses as valid Web App Manifest JSON with standalone display, icons, shortcuts, and zero gemini strings', () => {
    assert.ok(fs.existsSync(manifestPath), 'Expected PRANAV/public/manifest.webmanifest to exist');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    assert.doesNotMatch(raw, /gemini/i, 'manifest.webmanifest must not mention gemini');

    const manifest = JSON.parse(raw);
    assert.equal(manifest.name, 'SkySentry');
    assert.equal(manifest.short_name, 'SkySentry');
    assert.equal(manifest.id, '/app.html');
    assert.equal(manifest.start_url, '/app.html');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.background_color, '#0a0a0a');
    assert.equal(manifest.theme_color, '#0a0a0a');
    assert.match(manifest.description, /advisory/i);
    assert.match(manifest.description, /Local AI Model/);

    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
    const svgIcon = manifest.icons.find((i) => i.src === '/brand/favicon.svg');
    const png32 = manifest.icons.find((i) => i.src === '/brand/favicon-32.png');
    const touch180 = manifest.icons.find((i) => i.src === '/brand/apple-touch-icon.png');
    assert.ok(svgIcon && svgIcon.sizes === 'any', 'Expected /brand/favicon.svg (any)');
    assert.ok(png32 && png32.sizes === '32x32', 'Expected /brand/favicon-32.png (32x32)');
    assert.ok(
      touch180 && touch180.sizes === '180x180' && /any/.test(touch180.purpose) && /maskable/.test(touch180.purpose),
      'Expected /brand/apple-touch-icon.png (180x180, any & maskable)'
    );

    for (const icon of manifest.icons) {
      const diskPath = path.join(publicDir, icon.src.replace(/^\//, ''));
      assert.ok(fs.existsSync(diskPath), `Manifest icon missing on disk: ${icon.src}`);
    }

    assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 3);
    const shortcutUrls = manifest.shortcuts.map((s) => s.url);
    assert.ok(shortcutUrls.includes('/camera.html'), 'Expected Camera Station shortcut');
    assert.ok(shortcutUrls.includes('/tower.html'), 'Expected Tower Dashboard shortcut');
    assert.ok(shortcutUrls.includes('/app.html'), 'Expected App Hub shortcut');
  });

  test('perf-headers.js serves manifest.webmanifest and sw.js with no-cache revalidation and Vary: Accept-Encoding', () => {
    for (const rel of ['manifest.webmanifest', 'sw.js']) {
      const headers = new Map();
      const res = {
        getHeader: (k) => headers.get(k),
        setHeader: (k, v) => headers.set(k, v),
      };
      applyPerfStaticHeaders(res, path.join(publicDir, rel), { publicDir });
      assert.equal(headers.get('Cache-Control'), 'no-cache');
      assert.equal(headers.get('Vary'), 'Accept-Encoding');
    }
  });
});

/* ========================================================================== *
 *  2. app.html & app-hub.css Structure Verification                          *
 * ========================================================================== */

describe('app.html and app-hub.css contract', () => {
  test('app.html wires manifest, required data-* hooks, non-blocking Google Fonts, and zero gemini strings', () => {
    const html = fs.readFileSync(appHtmlPath, 'utf8');
    assert.doesNotMatch(html, /gemini/i, 'app.html must not mention gemini');
    assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest">/);
    assert.match(html, /<link\s+rel="stylesheet"\s+href="\/css\/app-hub\.css">/);
    assert.match(html, /<script\s+type="module"\s+src="\/js\/pwa-install\.mjs"><\/script>/);
    assert.match(html, /media="print"\s+onload="this\.media='all'"/);

    const requiredHooks = [
      'id="appHub"',
      'data-pwa-sw-status',
      'data-pwa-network-status',
      'data-pwa-standalone-badge',
      'data-pwa-install',
      'data-pwa-install-note',
      'data-pwa-ios-steps',
      'data-camera-qr',
      'data-camera-url',
      'data-copy-camera-url',
    ];
    for (const hook of requiredHooks) {
      assert.ok(html.includes(hook), `app.html missing required hook: ${hook}`);
    }
  });

  test('app-hub.css styles all App Hub classes, supports dark theme, and contains zero gemini references', () => {
    const css = fs.readFileSync(appHubCssPath, 'utf8');
    assert.doesNotMatch(css, /gemini/i);
    assert.match(css, /prefers-color-scheme:\s*dark/);
    assert.match(css, /:root\[data-theme="dark"\]/);

    const requiredClasses = [
      '.hub-body',
      '.hub-top',
      '.hub-top-inner',
      '.hub-nav',
      '.hub-status-row',
      '.hub-pill',
      '.hub-main',
      '.hub-hero',
      '.hub-eyebrow',
      '.hub-lead',
      '.hub-primary-grid',
      '.hub-card',
      '.hub-card-head',
      '.hub-kicker',
      '.hub-badge',
      '.hub-note',
      '.hub-actions',
      '.btn-hub',
      '.ios-steps',
      '.qr-layout',
      '.qr-frame',
      '.qr-box',
      '.camera-url-row',
      '.camera-url',
      '.hub-section',
      '.hub-section-head',
      '.launchpad-grid',
      '.launch-card',
      '.spec-grid',
      '.spec-card',
      '.spec-mono',
      '.ios-guide-stack',
      '.hub-code',
      '.hub-list',
      '.hub-foot',
      '.hub-foot-inner',
    ];

    for (const cls of requiredClasses) {
      assert.ok(css.includes(cls), `app-hub.css missing style rule for ${cls}`);
    }
  });
});

/* ========================================================================== *
 *  3. Service Worker Safety Bypass & Shell Caching                           *
 * ========================================================================== */

describe('sw.js strict safety bypass and static-shell caching', () => {
  test('shouldBypassServiceWorker strictly bypasses live APIs, sockets, health, models, clips, non-GET, auth headers, and cross-origin', () => {
    const sw = require(swPath);
    assert.equal(sw.CACHE_NAME, 'skysentry-shell-v1');
    assert.doesNotMatch(fs.readFileSync(swPath, 'utf8'), /gemini/i);

    const origin = 'https://skysentry.example';
    const mustBypass = [
      '/api/camera-frame',
      '/api/bird-review',
      '/socket.io/?EIO=4&transport=polling',
      '/health',
      '/health/live',
      '/ready',
      '/clips/sample-bird.mp4',
      '/promo/hero.webm',
      '/ai-models/coco/model.json',
      '/detection/models/weights.bin',
      '/sw.js',
      'https://fonts.googleapis.com/css2?family=Geist',
      'https://other-origin.example/app.html',
      { url: `${origin}/app.html`, method: 'POST' },
      { url: `${origin}/app.html`, method: 'DELETE' },
      { url: `${origin}/app.html`, method: 'GET', headers: { Authorization: 'Bearer tok_123' } },
      { url: `${origin}/app.html`, method: 'GET', headers: { 'x-api-key': 'cam-secret' } },
      { url: `${origin}/app.html`, method: 'GET', headers: new Map([['Range', 'bytes=0-1023']]) },
    ];

    for (const candidate of mustBypass) {
      assert.equal(
        sw.shouldBypassServiceWorker(candidate, origin),
        true,
        `Expected SW to bypass: ${JSON.stringify(candidate)}`
      );
    }

    const allowedShell = [
      '/app.html',
      '/tower.html',
      '/camera.html',
      '/manifest.webmanifest',
      '/css/app.css',
      '/css/app-hub.css',
      '/js/pwa-install.mjs',
      '/brand/favicon.svg',
      '/brand/apple-touch-icon.png',
    ];
    for (const pathUrl of allowedShell) {
      assert.equal(
        sw.shouldBypassServiceWorker({ url: `${origin}${pathUrl}`, method: 'GET', headers: {} }, origin),
        false,
        `Expected SW to allow static shell path: ${pathUrl}`
      );
    }
  });

  test('VM lifecycle: resilient install precache, old-cache cleanup on activate, zero interception on bypassed traffic, offline fallback & SWR', async () => {
    let networkOnline = true;
    const fetchedPaths = [];

    const env = createSwSandbox({
      initialCaches: {
        'skysentry-shell-v0': { '/old.css': { status: 200, body: 'stale' } },
        'unrelated-cache-v1': { '/keep': { status: 200, body: 'keep' } },
      },
      fetchImpl: async (req) => {
        const pathname = new URL(req.url, 'https://skysentry.example').pathname;
        fetchedPaths.push(pathname);
        if (!networkOnline) {
          throw new Error('offline');
        }
        // Simulate one optional asset 404 during precache to verify Promise.allSettled resilience
        if (pathname === '/brand/favicon-32.png') {
          return env.createResponse('not found', { status: 404 });
        }
        return env.createResponse(`fresh:${pathname}`, { status: 200 });
      },
    });

    await env.dispatchLifecycle('install');
    assert.equal(env.skippedWaiting, true);
    assert.ok(env.cacheMap.has('skysentry-shell-v1'));
    const v1Store = env.cacheMap.get('skysentry-shell-v1');
    assert.ok(v1Store.has('/app.html'), 'Expected /app.html precached despite optional 404');
    assert.ok(v1Store.has('/css/app-hub.css'), 'Expected /css/app-hub.css precached');
    assert.equal(v1Store.has('/brand/favicon-32.png'), false, '404 response must not be cached');

    await env.dispatchLifecycle('activate');
    assert.equal(env.claimed, true);
    assert.equal(env.cacheMap.has('skysentry-shell-v0'), false, 'Old skysentry-shell-* cache must be deleted');
    assert.equal(env.cacheMap.has('unrelated-cache-v1'), true, 'Unrelated caches must be left untouched');

    // Verify bypassed requests do NOT call event.respondWith
    const bypassedRequests = [
      new env.MockRequest('/api/camera-frame'),
      new env.MockRequest('/socket.io/?EIO=4'),
      new env.MockRequest('/health'),
      new env.MockRequest('/ready'),
      new env.MockRequest('/clips/test.mp4'),
      new env.MockRequest('/ai-models/coco/model.json'),
      new env.MockRequest('/app.html', { method: 'POST' }),
      new env.MockRequest('/app.html', { headers: { Authorization: 'Bearer secret' } }),
      new env.MockRequest('https://api.external.example/v1/data'),
    ];
    for (const req of bypassedRequests) {
      const result = env.dispatchFetch(req);
      assert.equal(result.intercepted, false, `Request must not be intercepted: ${req.method} ${req.url}`);
    }

    // Stale-while-revalidate on static CSS: returns cached shell immediately and revalidates in background
    v1Store.set('/css/app-hub.css', env.createResponse('cached:/css/app-hub.css'));
    const cssFetch = env.dispatchFetch(new env.MockRequest('/css/app-hub.css'));
    assert.equal(cssFetch.intercepted, true);
    const immediateCss = await cssFetch.responsePromise;
    assert.equal(immediateCss.body, 'cached:/css/app-hub.css');
    await Promise.all(cssFetch.backgroundTasks);
    assert.equal(v1Store.get('/css/app-hub.css').body, 'fresh:/css/app-hub.css');

    // Network-first with cache fallback on HTML navigation when offline
    networkOnline = false;
    const navFetch = env.dispatchFetch(
      new env.MockRequest('/app.html', { mode: 'navigate', headers: { accept: 'text/html' } })
    );
    assert.equal(navFetch.intercepted, true);
    const offlineHtml = await navFetch.responsePromise;
    assert.equal(offlineHtml.body, 'fresh:/app.html');
  });
});

/* ========================================================================== *
 *  4. pwa-install.mjs Behavioral Verification                                *
 * ========================================================================== */

describe('pwa-install.mjs App Hub controller', () => {
  test('imports cleanly, strips secrets from Camera QR URL, handles install prompt, iOS fallback, online/offline, QR & copy, and destroy()', async () => {
    assert.doesNotMatch(fs.readFileSync(pwaInstallPath, 'utf8'), /gemini/i);
    const mod = await import(pathToFileURL(pwaInstallPath).href);

    assert.equal(
      mod.buildCameraStationUrl('https://user:secret@tower.example:8443/app.html?apiKey=topsecret&token=xyz#frag'),
      'https://tower.example:8443/camera.html'
    );
    assert.equal(mod.buildCameraStationUrl('not-a-valid-url'), '/camera.html');

    let qrRenderedWith = null;
    class MockQRCode {
      constructor(el, opts) {
        qrRenderedWith = opts;
        el.innerHTML = `<canvas data-qr="${opts.text}"></canvas>`;
      }
    }

    const harness = createHubDomHarness({
      url: 'https://skysentry.example/app.html?apiKey=DO_NOT_LEAK#secret',
      QRCode: MockQRCode,
    });

    const controller = mod.initPwaAppHub({
      window: harness.window,
      document: harness.document,
      navigator: harness.navigator,
      location: harness.location,
      matchMedia: harness.matchMedia,
      root: harness.root,
      QRCode: MockQRCode,
    });

    await controller.swPromise;

    // SW status ready
    assert.equal(harness.elements['[data-pwa-sw-status]'].dataset.state, 'ready');
    assert.equal(harness.elements['[data-pwa-sw-status]'].textContent, 'Offline shell: ready');

    // Secret-free Camera Station URL & QR code
    assert.equal(harness.elements['[data-camera-url]'].textContent, 'https://skysentry.example/camera.html');
    assert.doesNotMatch(harness.elements['[data-camera-url]'].textContent, /DO_NOT_LEAK|secret/);
    assert.equal(qrRenderedWith.text, 'https://skysentry.example/camera.html');
    assert.match(harness.elements['[data-camera-qr]'].innerHTML, /<canvas/);

    // Copy camera URL button
    await harness.elements['[data-copy-camera-url]'].click();
    assert.deepEqual(harness.copiedValues, ['https://skysentry.example/camera.html']);
    assert.equal(harness.elements['[data-copy-camera-url]'].dataset.copied, 'true');

    // Online / offline network status updates
    harness.navigator.onLine = false;
    harness.window.emit('offline');
    assert.equal(harness.elements['[data-pwa-network-status]'].dataset.online, 'false');
    assert.equal(harness.elements['[data-pwa-network-status]'].textContent, 'Network: offline');

    harness.navigator.onLine = true;
    harness.window.emit('online');
    assert.equal(harness.elements['[data-pwa-network-status]'].dataset.online, 'true');
    assert.equal(harness.elements['[data-pwa-network-status]'].textContent, 'Network: online');

    // beforeinstallprompt -> button click -> appinstalled flow
    let prevented = false;
    let prompted = false;
    assert.equal(harness.elements['[data-pwa-install]'].disabled, true);
    harness.window.emit('beforeinstallprompt', {
      preventDefault() {
        prevented = true;
      },
      async prompt() {
        prompted = true;
        return { outcome: 'accepted' };
      },
    });
    assert.equal(prevented, true);
    assert.equal(harness.elements['[data-pwa-install]'].disabled, false);

    await harness.elements['[data-pwa-install]'].click();
    assert.equal(prompted, true);
    assert.match(harness.elements['[data-pwa-install-note]'].textContent, /accepted/i);

    harness.window.emit('appinstalled');
    assert.equal(harness.elements['[data-pwa-standalone-badge]'].hidden, false);
    assert.equal(harness.elements['[data-pwa-install]'].disabled, true);

    // Clean teardown stops mutating DOM on subsequent events
    controller.destroy();
    harness.navigator.onLine = false;
    harness.window.emit('offline');
    assert.equal(harness.elements['[data-pwa-network-status]'].dataset.online, 'true');
  });

  test('detects iOS Safari fallback, standalone display mode, inline SVG QR fallback, and unsupported Service Worker', async () => {
    const mod = await import(pathToFileURL(pwaInstallPath).href);

    const iosUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    assert.equal(mod.isIosSafari({ userAgent: iosUa, platform: 'iPhone', maxTouchPoints: 5 }), true);
    assert.equal(
      mod.isIosSafari({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15', maxTouchPoints: 0 }),
      false
    );

    const iosHarness = createHubDomHarness({
      userAgent: iosUa,
      platform: 'iPhone',
      maxTouchPoints: 5,
      serviceWorker: null,
      QRCode: null,
    });

    const hub = mod.initPwaAppHub({
      window: iosHarness.window,
      document: iosHarness.document,
      navigator: iosHarness.navigator,
      location: iosHarness.location,
      matchMedia: iosHarness.matchMedia,
      root: iosHarness.root,
    });
    await hub.swPromise;

    assert.equal(iosHarness.elements['[data-pwa-ios-steps]'].hidden, false);
    assert.equal(iosHarness.elements['[data-pwa-sw-status]'].dataset.state, 'unsupported');
    assert.match(iosHarness.elements['[data-camera-qr]'].innerHTML, /data-fallback="1"/);

    iosHarness.setStandalone(true);
    assert.equal(iosHarness.elements['[data-pwa-standalone-badge]'].hidden, false);
    assert.equal(iosHarness.elements['[data-pwa-ios-steps]'].hidden, true);
    hub.destroy();
  });

  test('renders real scannable QR SVG when /vendor/qrcode.min.js is loaded on window.qrcode', async () => {
    const mod = await import(pathToFileURL(pwaInstallPath).href);
    const vendorQrCode = fs.readFileSync(path.join(publicDir, 'vendor', 'qrcode.min.js'), 'utf8');
    const qrSandbox = {};
    vm.runInNewContext(vendorQrCode, qrSandbox);
    assert.equal(typeof qrSandbox.qrcode, 'function');

    const harness = createHubDomHarness({
      url: 'https://tower.skysentry.example/app.html?token=never-include',
      qrcode: qrSandbox.qrcode,
    });

    const hub = mod.initPwaAppHub({
      window: harness.window,
      document: harness.document,
      navigator: harness.navigator,
      location: harness.location,
      matchMedia: harness.matchMedia,
      root: harness.root,
      qrcode: qrSandbox.qrcode,
    });
    await hub.swPromise;

    assert.equal(harness.elements['[data-camera-qr]'].dataset.qrRendered, 'true');
    assert.match(harness.elements['[data-camera-qr]'].innerHTML, /<svg/i);
    assert.doesNotMatch(harness.elements['[data-camera-qr]'].innerHTML, /data-fallback="1"/);
    hub.destroy();
  });
});
