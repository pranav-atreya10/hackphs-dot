// SkySentry PWA App Hub controller & static-shell Service Worker registration.
// Guarded so importing or probing exports in Node without browser globals never throws.

function isDomElementLike(val) {
  return Boolean(
    val &&
      typeof val === 'object' &&
      (typeof val.nodeType === 'number' || typeof val.querySelector === 'function') &&
      !('window' in val) &&
      !('document' in val)
  );
}

function setDataAttr(el, dataKey, attrName, value) {
  if (!el || typeof el !== 'object') return;
  const str = String(value);
  if (el.dataset && typeof el.dataset === 'object') {
    el.dataset[dataKey] = str;
  }
  if (typeof el.setAttribute === 'function') {
    el.setAttribute(attrName, str);
  }
}

function setHiddenState(el, hidden) {
  if (!el || typeof el !== 'object') return;
  const next = Boolean(hidden);
  el.hidden = next;
  if (next) {
    if (typeof el.setAttribute === 'function') el.setAttribute('hidden', '');
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('hidden');
  }
}

export function isIosSafari(navOrOptions) {
  let nav = null;
  if (navOrOptions && typeof navOrOptions === 'object' && !isDomElementLike(navOrOptions)) {
    if ('userAgent' in navOrOptions || 'platform' in navOrOptions || 'maxTouchPoints' in navOrOptions) {
      nav = navOrOptions;
    } else if (navOrOptions.navigator && typeof navOrOptions.navigator === 'object') {
      nav = navOrOptions.navigator;
    } else if (navOrOptions.window && navOrOptions.window.navigator) {
      nav = navOrOptions.window.navigator;
    }
  }
  if (!nav && typeof globalThis.navigator !== 'undefined') {
    nav = globalThis.navigator;
  }
  if (!nav || typeof nav !== 'object') return false;

  const ua = String(nav.userAgent || '');
  const platform = String(nav.platform || '');
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);

  const isIosDevice =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh|MacIntel/i.test(platform || ua) && maxTouchPoints > 1);
  if (!isIosDevice) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|Android/i.test(ua)) return false;

  return /Safari|AppleWebKit/i.test(ua) || !/Mozilla\//i.test(ua);
}

export function isStandaloneDisplayMode(envOrOptions) {
  const opts =
    envOrOptions && typeof envOrOptions === 'object' && !isDomElementLike(envOrOptions)
      ? envOrOptions
      : {};

  const win = opts.window ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);
  const matchMediaFn =
    typeof opts.matchMedia === 'function'
      ? opts.matchMedia
      : win && typeof win.matchMedia === 'function'
        ? win.matchMedia.bind(win)
        : typeof globalThis.matchMedia === 'function'
          ? globalThis.matchMedia
          : null;
  const nav =
    opts.navigator ??
    (win && win.navigator ? win.navigator : typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null);

  let mediaStandalone = false;
  if (typeof matchMediaFn === 'function') {
    try {
      mediaStandalone = Boolean(matchMediaFn('(display-mode: standalone)')?.matches);
    } catch {
      mediaStandalone = false;
    }
  }

  return Boolean(mediaStandalone || (nav && nav.standalone === true));
}

export function buildCameraStationUrl(locationOrOrigin) {
  let raw = '';

  if (typeof locationOrOrigin === 'string') {
    raw = locationOrOrigin.trim();
  } else if (locationOrOrigin instanceof URL) {
    raw = locationOrOrigin.href;
  } else if (locationOrOrigin && typeof locationOrOrigin === 'object' && !isDomElementLike(locationOrOrigin)) {
    const locObj = locationOrOrigin.location ?? locationOrOrigin;
    if (typeof locObj.href === 'string' && locObj.href) {
      raw = locObj.href;
    } else if (typeof locObj.origin === 'string' && locObj.origin && locObj.origin !== 'null') {
      raw = locObj.origin;
    } else if (typeof locObj.protocol === 'string' && typeof locObj.host === 'string' && locObj.host) {
      raw = `${locObj.protocol}//${locObj.host}`;
    }
  }

  if (!raw) {
    const globalLoc =
      (typeof globalThis.location !== 'undefined' && globalThis.location) ||
      (typeof globalThis.window !== 'undefined' && globalThis.window && globalThis.window.location) ||
      null;
    if (globalLoc) {
      raw = typeof globalLoc.href === 'string' && globalLoc.href ? globalLoc.href : String(globalLoc.origin || '');
    }
  }

  if (!raw) return '/camera.html';

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}/camera.html`;
    }
  } catch {
    // Fall back to relative path when origin is non-HTTP or unparseable
  }

  return '/camera.html';
}

function updateSwStatusElement(statusEl, state) {
  if (!statusEl) return;
  const labels = {
    checking: 'Offline shell: checking…',
    ready: 'Offline shell: ready',
    unsupported: 'Offline shell: unsupported',
    error: 'Offline shell: error',
  };
  const normalized = labels[state] ? state : 'error';
  setDataAttr(statusEl, 'state', 'data-state', normalized);
  statusEl.textContent = labels[normalized];
}

export async function registerSkySentryServiceWorker(firstArg = {}, secondArg = {}) {
  const opts = isDomElementLike(firstArg)
    ? (secondArg && typeof secondArg === 'object' ? secondArg : {})
    : (firstArg && typeof firstArg === 'object' ? firstArg : {});

  const win = opts.window ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);
  const nav =
    opts.navigator ??
    (win && win.navigator ? win.navigator : typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null);
  const loc =
    opts.location ??
    (win && win.location ? win.location : typeof globalThis.location !== 'undefined' ? globalThis.location : null);
  const swUrl = typeof opts.swUrl === 'string' && opts.swUrl ? opts.swUrl : '/sw.js';
  const scope = typeof opts.scope === 'string' && opts.scope ? opts.scope : '/';
  const statusEl = isDomElementLike(opts.statusEl) ? opts.statusEl : null;
  const onStatusChange = typeof opts.onStatusChange === 'function' ? opts.onStatusChange : null;

  const notify = (state, registration = null, error = null) => {
    updateSwStatusElement(statusEl, state);
    if (onStatusChange) {
      try {
        onStatusChange(state, registration, error);
      } catch {
        // Ignore callback errors
      }
    }
  };

  if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.register !== 'function') {
    notify('unsupported', null, null);
    return { supported: false, state: 'unsupported', registration: null, destroy() {} };
  }

  if (loc && typeof loc.protocol === 'string' && loc.protocol === 'http:') {
    const host = String(loc.hostname || '');
    const isLocalhost = /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i.test(host);
    if (host && !isLocalhost) {
      notify('unsupported', null, null);
      return { supported: false, state: 'unsupported', registration: null, destroy() {} };
    }
  }

  notify('checking', null, null);

  try {
    const registration = await nav.serviceWorker.register(swUrl, { scope });
    notify('ready', registration, null);
    return { supported: true, state: 'ready', registration, destroy() {} };
  } catch (error) {
    notify('error', null, error);
    return { supported: true, state: 'error', registration: null, error, destroy() {} };
  }
}

function renderCameraQrIntoBox(qrBoxEl, cameraUrl, qrProviders = {}) {
  if (!qrBoxEl || !cameraUrl) return false;
  const fallbackHtml = typeof qrBoxEl.innerHTML === 'string' ? qrBoxEl.innerHTML : '';

  const QRCodeCtor =
    qrProviders.QRCode ??
    (qrProviders.window && qrProviders.window.QRCode) ??
    (typeof globalThis.QRCode !== 'undefined' ? globalThis.QRCode : null);

  if (typeof QRCodeCtor === 'function') {
    try {
      qrBoxEl.innerHTML = '';
      new QRCodeCtor(qrBoxEl, {
        text: cameraUrl,
        width: 144,
        height: 144,
        colorDark: '#0a0a0a',
        colorLight: '#ffffff',
      });
      setDataAttr(qrBoxEl, 'qrRendered', 'data-qr-rendered', 'true');
      return true;
    } catch {
      qrBoxEl.innerHTML = fallbackHtml;
    }
  } else if (QRCodeCtor && typeof QRCodeCtor === 'object' && typeof QRCodeCtor.toString === 'function') {
    try {
      const out = QRCodeCtor.toString(cameraUrl, { type: 'svg' });
      if (typeof out === 'string' && out.includes('<svg')) {
        qrBoxEl.innerHTML = out;
        setDataAttr(qrBoxEl, 'qrRendered', 'data-qr-rendered', 'true');
        return true;
      }
    } catch {
      qrBoxEl.innerHTML = fallbackHtml;
    }
  }

  const qrcodeFactory =
    qrProviders.qrcode ??
    (qrProviders.window && qrProviders.window.qrcode) ??
    (typeof globalThis.qrcode !== 'undefined' ? globalThis.qrcode : null);

  if (typeof qrcodeFactory === 'function') {
    try {
      const qr = qrcodeFactory(0, 'M');
      qr.addData(cameraUrl);
      qr.make();
      if (typeof qr.createSvgTag === 'function') {
        qrBoxEl.innerHTML = qr.createSvgTag(4, 0);
      } else if (typeof qr.createImgTag === 'function') {
        qrBoxEl.innerHTML = qr.createImgTag(4, 0, 'QR code to open the SkySentry Camera Station on a phone');
      } else {
        return false;
      }
      setDataAttr(qrBoxEl, 'qrRendered', 'data-qr-rendered', 'true');
      return true;
    } catch {
      qrBoxEl.innerHTML = fallbackHtml;
    }
  }

  return false;
}

export function initPwaAppHub(firstArg = {}, secondArg = {}) {
  const opts = isDomElementLike(firstArg)
    ? { ...(secondArg && typeof secondArg === 'object' ? secondArg : {}), root: firstArg }
    : (firstArg && typeof firstArg === 'object' ? firstArg : {});

  const win = opts.window ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);
  const doc =
    opts.document ??
    (win && win.document ? win.document : typeof globalThis.document !== 'undefined' ? globalThis.document : null);
  const nav =
    opts.navigator ??
    (win && win.navigator ? win.navigator : typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null);
  const loc =
    opts.location ??
    (win && win.location ? win.location : typeof globalThis.location !== 'undefined' ? globalThis.location : null);

  const root = isDomElementLike(opts.root)
    ? opts.root
    : doc && typeof doc.getElementById === 'function'
      ? doc.getElementById('appHub') || doc
      : doc;

  if (!win && !doc && !root) {
    return { cameraUrl: '/camera.html', swPromise: Promise.resolve(null), destroy() {} };
  }

  const select = (selector) => {
    if (root && typeof root.querySelector === 'function') {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    if (doc && doc !== root && typeof doc.querySelector === 'function') {
      return doc.querySelector(selector);
    }
    return null;
  };

  const swStatusEl = select('[data-pwa-sw-status]');
  const netStatusEl = select('[data-pwa-network-status]');
  const standaloneBadgeEl = select('[data-pwa-standalone-badge]');
  const installBtnEl = select('[data-pwa-install]');
  const installNoteEl = select('[data-pwa-install-note]');
  const iosStepsEl = select('[data-pwa-ios-steps]');
  const qrBoxEl = select('[data-camera-qr]');
  const cameraUrlEl = select('[data-camera-url]');
  const copyBtnEl = select('[data-copy-camera-url]');

  const cleanups = [];
  let destroyed = false;
  let deferredPrompt = null;
  let copyResetTimer = null;

  const listen = (target, type, handler, listenerOpts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, listenerOpts);
    cleanups.push(() => {
      if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, handler, listenerOpts);
      }
    });
  };

  // 1. Network online/offline status pill
  const syncNetworkStatus = () => {
    if (destroyed || !netStatusEl) return;
    const online = nav && typeof nav.onLine === 'boolean' ? nav.onLine : true;
    setDataAttr(netStatusEl, 'online', 'data-online', online ? 'true' : 'false');
    netStatusEl.textContent = online ? 'Network: online' : 'Network: offline';
  };
  syncNetworkStatus();
  listen(win, 'online', syncNetworkStatus);
  listen(win, 'offline', syncNetworkStatus);

  // 2. Standalone display mode & install / iOS flow
  const syncInstallSurface = () => {
    if (destroyed) return;
    const standalone = isStandaloneDisplayMode({ window: win, navigator: nav, matchMedia: opts.matchMedia });
    setHiddenState(standaloneBadgeEl, !standalone);

    if (standalone) {
      setHiddenState(iosStepsEl, true);
      if (installBtnEl) {
        installBtnEl.disabled = true;
        installBtnEl.textContent = 'App Installed';
      }
      if (installNoteEl) {
        installNoteEl.textContent = 'Running in standalone app mode.';
      }
      return;
    }

    if (deferredPrompt) {
      setHiddenState(iosStepsEl, true);
      if (installBtnEl) {
        installBtnEl.disabled = false;
        installBtnEl.textContent = 'Install SkySentry App';
      }
      if (installNoteEl) {
        installNoteEl.textContent = 'Ready to install as a standalone app.';
      }
      return;
    }

    const ios = isIosSafari(nav) || Boolean(nav && /iPad|iPhone|iPod/i.test(String(nav.userAgent || '')));
    setHiddenState(iosStepsEl, !ios);
    if (installBtnEl) {
      installBtnEl.disabled = true;
    }
    if (installNoteEl) {
      installNoteEl.textContent = ios
        ? 'On iPhone or iPad, use Safari Share → Add to Home Screen below.'
        : 'Use your browser address bar or menu to install if no prompt appears.';
    }
  };

  syncInstallSurface();

  const matchMediaFn =
    typeof opts.matchMedia === 'function'
      ? opts.matchMedia
      : win && typeof win.matchMedia === 'function'
        ? win.matchMedia.bind(win)
        : null;
  if (typeof matchMediaFn === 'function') {
    try {
      const mql = matchMediaFn('(display-mode: standalone)');
      if (mql) listen(mql, 'change', syncInstallSurface);
    } catch {
      // Ignore matchMedia errors
    }
  }

  listen(win, 'beforeinstallprompt', (event) => {
    if (destroyed) return;
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    deferredPrompt = event;
    syncInstallSurface();
  });

  listen(win, 'appinstalled', () => {
    if (destroyed) return;
    deferredPrompt = null;
    setHiddenState(standaloneBadgeEl, false);
    setHiddenState(iosStepsEl, true);
    if (installBtnEl) {
      installBtnEl.disabled = true;
      installBtnEl.textContent = 'App Installed';
    }
    if (installNoteEl) {
      installNoteEl.textContent = 'SkySentry installed on this device.';
    }
  });

  if (installBtnEl) {
    listen(installBtnEl, 'click', async () => {
      if (destroyed) return;
      if (!deferredPrompt) {
        syncInstallSurface();
        return;
      }
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      installBtnEl.disabled = true;

      try {
        const promptResult = typeof promptEvent.prompt === 'function' ? await promptEvent.prompt() : null;
        const choice =
          promptResult && typeof promptResult.outcome === 'string'
            ? promptResult
            : promptEvent.userChoice
              ? await promptEvent.userChoice
              : null;
        const accepted = choice && choice.outcome === 'accepted';
        if (installNoteEl) {
          installNoteEl.textContent = accepted
            ? 'SkySentry installation accepted.'
            : 'Install prompt dismissed. You can install later from your browser menu.';
        }
      } catch {
        if (installNoteEl) {
          installNoteEl.textContent = 'Installation prompt could not be completed.';
        }
      }
    });
  }

  // 3. Clean secret-free Camera Station QR & copy link
  const cameraUrl = buildCameraStationUrl(loc);
  if (cameraUrlEl) {
    cameraUrlEl.textContent = cameraUrl;
  }

  const tryRenderQr = () => {
    if (destroyed || !qrBoxEl) return false;
    return renderCameraQrIntoBox(qrBoxEl, cameraUrl, {
      QRCode: opts.QRCode,
      qrcode: opts.qrcode,
      window: win,
    });
  };

  if (!tryRenderQr()) {
    listen(win, 'load', tryRenderQr);
    if (doc && typeof doc.querySelector === 'function') {
      const qrScript = doc.querySelector('script[src*="qrcode"]');
      if (qrScript) listen(qrScript, 'load', tryRenderQr);
    }
  }

  if (copyBtnEl) {
    const defaultCopyLabel = copyBtnEl.textContent || 'Copy camera link';
    const setTimeoutFn =
      win && typeof win.setTimeout === 'function'
        ? win.setTimeout.bind(win)
        : typeof globalThis.setTimeout === 'function'
          ? globalThis.setTimeout
          : null;
    const clearTimeoutFn =
      win && typeof win.clearTimeout === 'function'
        ? win.clearTimeout.bind(win)
        : typeof globalThis.clearTimeout === 'function'
          ? globalThis.clearTimeout
          : null;

    listen(copyBtnEl, 'click', async () => {
      if (destroyed) return;
      let copied = false;

      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        try {
          await nav.clipboard.writeText(cameraUrl);
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (!copied && doc && typeof doc.createElement === 'function' && typeof doc.execCommand === 'function' && doc.body) {
        try {
          const temp = doc.createElement('textarea');
          temp.value = cameraUrl;
          temp.setAttribute('readonly', '');
          temp.style.position = 'fixed';
          temp.style.opacity = '0';
          doc.body.appendChild(temp);
          if (typeof temp.select === 'function') temp.select();
          copied = Boolean(doc.execCommand('copy'));
          if (typeof temp.remove === 'function') temp.remove();
        } catch {
          copied = false;
        }
      }

      setDataAttr(copyBtnEl, 'copied', 'data-copied', copied ? 'true' : 'false');
      copyBtnEl.textContent = copied ? 'Copied camera link' : 'Copy unavailable';
      if (typeof copyBtnEl.setAttribute === 'function') {
        copyBtnEl.setAttribute(
          'aria-label',
          copied ? `Copied ${cameraUrl} to clipboard` : 'Clipboard unavailable; copy camera URL manually'
        );
      }

      if (copyResetTimer !== null && clearTimeoutFn) {
        clearTimeoutFn(copyResetTimer);
      }
      if (setTimeoutFn) {
        copyResetTimer = setTimeoutFn(() => {
          if (destroyed) return;
          copyBtnEl.textContent = defaultCopyLabel;
          setDataAttr(copyBtnEl, 'copied', 'data-copied', 'false');
          if (typeof copyBtnEl.removeAttribute === 'function') {
            copyBtnEl.removeAttribute('aria-label');
          }
        }, 2200);
      }
    });

    cleanups.push(() => {
      if (copyResetTimer !== null && clearTimeoutFn) {
        clearTimeoutFn(copyResetTimer);
        copyResetTimer = null;
      }
    });
  }

  // 4. Service Worker registration
  const swPromise =
    opts.registerServiceWorker === false
      ? Promise.resolve({ supported: false, state: 'unsupported', registration: null })
      : registerSkySentryServiceWorker({
          window: win,
          navigator: nav,
          location: loc,
          swUrl: opts.swUrl,
          scope: opts.scope,
          statusEl: swStatusEl,
        });

  return {
    cameraUrl,
    swPromise,
    refreshQr: tryRenderQr,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      deferredPrompt = null;
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        try {
          fn();
        } catch {
          // Ignore teardown errors
        }
      }
    },
  };
}

if (
  typeof globalThis.window !== 'undefined' &&
  typeof globalThis.document !== 'undefined' &&
  globalThis.document &&
  typeof globalThis.document.getElementById === 'function'
) {
  if (globalThis.document.getElementById('appHub')) {
    initPwaAppHub();
  } else if (
    typeof globalThis.navigator !== 'undefined' &&
    globalThis.navigator &&
    globalThis.navigator.serviceWorker &&
    typeof globalThis.navigator.serviceWorker.register === 'function'
  ) {
    registerSkySentryServiceWorker();
  }
}
