// Interactive Runway Operations & Advisory Trajectory Clash Board UI.
//
// Pure ES module for SkySentry Tower:
//   - Zero top-level browser global reads; imports and probes cleanly in Node without DOM globals.
//   - Connects to RunwayOpsStore and evaluates trajectory overlaps strictly on live, non-demo
//     cameras with a calibrated corridor survey (`Boolean(surveyId)` and surveyed corridor mask).
//   - Advisory HUD/board display only; never alters server detection state or tower risk.

import {
  createRunwayOpsStore,
  DEFAULT_MAX_OPS,
  OP_BUFFER_SEC,
  VALID_OP_KINDS,
  normalizeAirportCode,
} from './runway-ops-store.mjs';

export {
  createRunwayOpsStore,
  DEFAULT_MAX_OPS,
  OP_BUFFER_SEC,
  VALID_OP_KINDS,
  normalizeAirportCode,
};

export const CLASH_ADVISORY_DISCLAIMER =
  'Advisory trajectory projection on surveyed camera masks only — not ATC separation or runway clearance';

export const NO_SURVEYED_CORRIDOR_NOTE =
  'No surveyed corridor camera active — uncalibrated and demo feeds cannot evaluate trajectory clashes';

export const COUNTDOWN_INTERVAL_MS = 1000;

export const DEFAULT_OP_PRESETS = Object.freeze([
  Object.freeze({ kind: 'departure', inSec: 30, label: 'Departure +30s' }),
  Object.freeze({ kind: 'departure', inSec: 60, label: 'Departure +60s' }),
  Object.freeze({ kind: 'departure', inSec: 90, label: 'Departure +90s' }),
  Object.freeze({ kind: 'arrival', inSec: 30, label: 'Arrival +30s' }),
  Object.freeze({ kind: 'arrival', inSec: 60, label: 'Arrival +60s' }),
  Object.freeze({ kind: 'arrival', inSec: 90, label: 'Arrival +90s' }),
]);

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const mountedBoards = new WeakMap();

function createUnmountedController() {
  return {
    element: null,
    store: null,
    setAirport() {},
    getAirport() {
      return '';
    },
    updateForecasts() {
      return [];
    },
    logOperation() {
      return null;
    },
    removeOperation() {
      return false;
    },
    clearOperations() {},
    getActiveOperations() {
      return [];
    },
    getClashes() {
      return [];
    },
    hasSurveyedCorridor() {
      return false;
    },
    isReducedMotion() {
      return false;
    },
    refresh() {},
    destroy() {},
  };
}

function isMountableContainer(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'CANVAS') return false;
  return typeof el.append === 'function' || typeof el.appendChild === 'function';
}

function nonEmptyTrimmed(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonEmptyStringId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return nonEmptyTrimmed(value);
}

function setClasses(el, ...names) {
  if (!el || typeof el !== 'object') return;
  const clean = names.filter(Boolean);
  const joined = clean.join(' ');
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('class', joined);
  }
  if ('className' in el) {
    try {
      el.className = joined;
    } catch {
      // Ignore read-only className on SVG/mock nodes if setAttribute handled it.
    }
  }
  if (el.classList && typeof el.classList.add === 'function') {
    for (const cls of clean) {
      if (typeof el.classList.contains !== 'function' || !el.classList.contains(cls)) {
        el.classList.add(cls);
      }
    }
  }
}

function setAttr(el, name, value) {
  if (!el || typeof el !== 'object') return;
  if (value === null || value === undefined) {
    if (typeof el.removeAttribute === 'function') el.removeAttribute(name);
    return;
  }
  if (typeof el.setAttribute === 'function') {
    el.setAttribute(name, String(value));
  }
}

function setData(el, key, value) {
  if (!el || typeof el !== 'object') return;
  const attr = `data-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
  if (value === null || value === undefined) {
    if (el.dataset && typeof el.dataset === 'object') {
      delete el.dataset[key];
    }
    if (typeof el.removeAttribute === 'function') {
      el.removeAttribute(attr);
    }
    return;
  }
  const str = String(value);
  if (el.dataset && typeof el.dataset === 'object') {
    el.dataset[key] = str;
  }
  if (typeof el.setAttribute === 'function') {
    el.setAttribute(attr, str);
  }
}

function setVisible(el, visible) {
  if (!el || typeof el !== 'object') return;
  const nextHidden = !visible;
  if ('hidden' in el || typeof el.setAttribute !== 'function') {
    try {
      el.hidden = nextHidden;
    } catch {
      // Ignore read-only mock properties.
    }
  }
  if (nextHidden) {
    if (typeof el.setAttribute === 'function') el.setAttribute('hidden', '');
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('hidden');
  }
}

function setDisabled(el, disabled) {
  if (!el || typeof el !== 'object') return;
  const isOff = Boolean(disabled);
  try {
    el.disabled = isOff;
  } catch {
    // Ignore read-only mock properties.
  }
  if (isOff) {
    if (typeof el.setAttribute === 'function') el.setAttribute('disabled', '');
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('disabled');
  }
}

function appendNodes(parent, ...nodes) {
  if (!parent || typeof parent !== 'object') return;
  const valid = nodes.filter(Boolean);
  if (!valid.length) return;
  for (const node of valid) {
    if (node && typeof node === 'object' && 'parentNode' in node) {
      try {
        node.parentNode = parent;
      } catch {
        // Real DOM updates parentNode automatically on append/appendChild.
      }
    }
  }
  if (typeof parent.append === 'function') {
    parent.append(...valid);
    return;
  }
  if (typeof parent.appendChild === 'function') {
    for (const node of valid) parent.appendChild(node);
    return;
  }
  if (Array.isArray(parent.children)) {
    parent.children.push(...valid);
  }
}

function replaceNodeChildren(parent, nodes) {
  if (!parent || typeof parent !== 'object') return;
  const valid = nodes.filter(Boolean);
  for (const node of valid) {
    if (node && typeof node === 'object' && 'parentNode' in node) {
      try {
        node.parentNode = parent;
      } catch {
        // Real DOM updates parentNode automatically.
      }
    }
  }
  if (typeof parent.replaceChildren === 'function') {
    parent.replaceChildren(...valid);
    if (Array.isArray(parent.children) && parent.children.length !== valid.length) {
      try {
        parent.children = [...valid];
      } catch {
        // Real HTMLCollection is read-only and already updated by replaceChildren.
      }
    }
    return;
  }
  if (typeof parent.removeChild === 'function' && typeof parent.appendChild === 'function') {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    for (const node of valid) parent.appendChild(node);
    return;
  }
  if (Array.isArray(parent.children)) {
    parent.children = [...valid];
  }
}

function detachFromContainer(containerEl, childEl) {
  if (!childEl || typeof childEl !== 'object') return;
  if (typeof childEl.remove === 'function') {
    childEl.remove();
  } else if (childEl.parentNode && typeof childEl.parentNode.removeChild === 'function') {
    childEl.parentNode.removeChild(childEl);
  }
  if (containerEl && Array.isArray(containerEl.children)) {
    const idx = containerEl.children.indexOf(childEl);
    if (idx !== -1) containerEl.children.splice(idx, 1);
  }
}

function listen(target, eventName, handler) {
  if (!target || typeof target.addEventListener !== 'function') {
    return () => {};
  }
  target.addEventListener(eventName, handler);
  return () => {
    if (typeof target.removeEventListener === 'function') {
      target.removeEventListener(eventName, handler);
    }
  };
}

function createEl(doc, tagName, ...classNames) {
  const el = doc.createElement(tagName);
  setVisible(el, true);
  if (classNames.length > 0) {
    setClasses(el, ...classNames);
  }
  return el;
}

function extractCameraEntries(forecastsByCamera) {
  if (!forecastsByCamera || typeof forecastsByCamera !== 'object') return [];
  if (forecastsByCamera instanceof Map) {
    return [...forecastsByCamera.entries()];
  }
  if (Array.isArray(forecastsByCamera)) {
    const out = [];
    for (let i = 0; i < forecastsByCamera.length; i++) {
      const item = forecastsByCamera[i];
      if (!item || typeof item !== 'object') continue;
      const key = nonEmptyStringId(item.cameraId) ?? nonEmptyStringId(item.id) ?? `camera-${i}`;
      out.push([key, item]);
    }
    return out;
  }
  return Object.entries(forecastsByCamera);
}

function resolveForecasterInstance(src) {
  if (!src || typeof src !== 'object') return null;
  if (typeof src.forecastAll === 'function' && typeof src.hasCorridor === 'function') {
    return src;
  }
  if (src.forecaster && typeof src.forecaster.forecastAll === 'function') {
    return src.forecaster;
  }
  if (src.hud && src.hud.forecaster && typeof src.hud.forecaster.forecastAll === 'function') {
    return src.hud.forecaster;
  }
  return null;
}

function isDemoFeed(src, forecaster) {
  if (!src || typeof src !== 'object') return false;
  if (Boolean(src.demo) || src.isDemo === true) return true;
  if (src.source === 'demo' || src.sourceMode === 'demo' || src.mode === 'demo') return true;
  if (src.corridor && typeof src.corridor === 'object' && !Array.isArray(src.corridor)) {
    if (Boolean(src.corridor.demo)) return true;
  }
  if (src.config && typeof src.config === 'object' && Boolean(src.config.demo)) {
    return true;
  }
  if (forecaster?.cfg && typeof forecaster.cfg === 'object' && Boolean(forecaster.cfg.demo)) {
    return true;
  }
  return false;
}

function isExplicitlyUnsurveyed(src) {
  if (!src || typeof src !== 'object') return true;
  if (src.corridorSurveyed === false || src.surveyedCorridor === false) return true;
  if (src.corridor && typeof src.corridor === 'object' && !Array.isArray(src.corridor)) {
    if (src.corridor.surveyed === false) return true;
  }
  return false;
}

function hasNonDegeneratePolygon(poly) {
  return Array.isArray(poly) && poly.length >= 3;
}

function sanitizeForecastSources(forecastsByCamera, normAirport) {
  if (!normAirport || !forecastsByCamera || typeof forecastsByCamera !== 'object') {
    return { surveyedCameraCount: 0, sanitizedByCamera: null };
  }

  const entries = extractCameraEntries(forecastsByCamera);
  const sanitizedByCamera = new Map();
  let surveyedCameraCount = 0;

  for (const [entryKey, src] of entries) {
    if (!src || typeof src !== 'object') continue;

    if (Array.isArray(src)) {
      const cameraId = nonEmptyStringId(entryKey) ?? 'camera';
      const validForecasts = src.filter(
        f =>
          f &&
          typeof f === 'object' &&
          !Boolean(f.demo) &&
          f.corridorSurveyed === true &&
          Boolean(nonEmptyTrimmed(f.surveyId)),
      );
      if (validForecasts.length > 0) {
        surveyedCameraCount += 1;
        sanitizedByCamera.set(cameraId, {
          cameraId,
          cameraLabel: cameraId,
          airport: normAirport,
          surveyId: nonEmptyTrimmed(validForecasts[0].surveyId),
          forecasts: validForecasts,
        });
      }
      continue;
    }

    if (typeof src.airport === 'string') {
      const srcAirport = normalizeAirportCode(src.airport);
      if (srcAirport && srcAirport !== normAirport) continue;
    }

    const forecaster = resolveForecasterInstance(src);
    if (isDemoFeed(src, forecaster) || isExplicitlyUnsurveyed(src)) {
      continue;
    }

    const cameraId = nonEmptyStringId(src.cameraId) ?? nonEmptyStringId(entryKey) ?? 'camera';
    const cameraLabel = nonEmptyTrimmed(src.cameraLabel) ?? cameraId;
    const containerSurveyId =
      nonEmptyTrimmed(src.surveyId) ??
      nonEmptyTrimmed(src.config?.surveyId) ??
      nonEmptyTrimmed(src.corridor?.surveyId);

    if (forecaster) {
      if (forecaster.hasCorridor?.() !== true) continue;
      const surveyId = containerSurveyId ?? nonEmptyTrimmed(forecaster.surveyId);
      if (!surveyId) continue;
      surveyedCameraCount += 1;
      sanitizedByCamera.set(cameraId, {
        cameraId,
        cameraLabel,
        airport: normAirport,
        surveyId,
        forecaster,
      });
      continue;
    }

    const rawList = Array.isArray(src.forecasts)
      ? src.forecasts
      : src.hud?.forecasts instanceof Map
        ? [...src.hud.forecasts.values()]
        : null;

    const containerHasSurveyedMask =
      Boolean(containerSurveyId) &&
      (src.corridorSurveyed === true ||
        src.surveyedCorridor === true ||
        src.corridor?.surveyed === true ||
        hasNonDegeneratePolygon(src.corridor) ||
        hasNonDegeneratePolygon(src.corridor?.polygon) ||
        hasNonDegeneratePolygon(src.corridor?.corridor) ||
        hasNonDegeneratePolygon(src.config?.corridor));

    if (rawList) {
      const validForecasts = [];
      for (const f of rawList) {
        if (!f || typeof f !== 'object' || Boolean(f.demo) || f.corridorSurveyed !== true) {
          continue;
        }
        const resolvedSurveyId = nonEmptyTrimmed(f.surveyId) ?? containerSurveyId;
        if (!resolvedSurveyId) continue;
        validForecasts.push(f.surveyId ? f : { ...f, surveyId: resolvedSurveyId });
      }

      if (validForecasts.length > 0 || containerHasSurveyedMask) {
        surveyedCameraCount += 1;
        if (validForecasts.length > 0) {
          sanitizedByCamera.set(cameraId, {
            cameraId,
            cameraLabel,
            airport: normAirport,
            surveyId: containerSurveyId ?? nonEmptyTrimmed(validForecasts[0].surveyId),
            forecasts: validForecasts,
          });
        }
      }
      continue;
    }

    if (containerHasSurveyedMask) {
      surveyedCameraCount += 1;
    }
  }

  return { surveyedCameraCount, sanitizedByCamera };
}

function formatCountdownSec(inSec) {
  const sec = Number.isFinite(inSec) ? Math.max(1, Math.round(inSec)) : 1;
  return `T-${sec}s`;
}

function formatOperationMeta(op) {
  const callsign = nonEmptyTrimmed(op.callsign);
  const runway = nonEmptyTrimmed(op.runway);
  if (callsign && runway) return `${callsign} · RWY ${runway}`;
  if (callsign) return callsign;
  if (runway) return `RWY ${runway}`;
  return op.kind === 'arrival' ? 'Scheduled arrival' : 'Scheduled departure';
}

function formatClashHeadline(clash) {
  const parts = [];
  const callsign = nonEmptyTrimmed(clash.callsign);
  const runway = nonEmptyTrimmed(clash.runway);
  if (callsign) parts.push(callsign);
  if (runway) parts.push(`RWY ${runway}`);
  const prefix = parts.length > 0 ? `${parts.join(' · ')} — ` : '';
  return `${prefix}${clash.message || `${clash.kind} trajectory overlap`}`;
}

function formatClashMeta(clash) {
  const camName = nonEmptyTrimmed(clash.cameraLabel) ?? clash.cameraId ?? 'camera';
  const surveyPart = nonEmptyTrimmed(clash.surveyId) ? ` (${clash.surveyId.trim()})` : '';
  const segs = [
    `Cam ${camName}${surveyPart}`,
    `Track #${clash.trackId} (${clash.cls || 'object'})`,
    formatCountdownSec(clash.inSec),
  ];
  if (Number.isFinite(clash.pWithin60)) {
    segs.push(`P(60s) ${Math.round(clash.pWithin60 * 100)}%`);
  }
  if (clash.eta && Number.isFinite(clash.eta.p10) && Number.isFinite(clash.eta.p90)) {
    segs.push(`ETA ${Math.round(clash.eta.p10)}-${Math.round(clash.eta.p90)}s`);
  }
  return segs.join(' · ');
}

function normalizePresets(rawPresets) {
  if (!Array.isArray(rawPresets) || rawPresets.length === 0) {
    return DEFAULT_OP_PRESETS;
  }
  const cleaned = [];
  for (const item of rawPresets) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind === 'arrival' ? 'arrival' : item.kind === 'departure' ? 'departure' : null;
    const inSec = Number(item.inSec);
    if (!kind || !Number.isFinite(inSec) || inSec <= 0) continue;
    const kindLabel = kind === 'arrival' ? 'Arrival' : 'Departure';
    const label = nonEmptyTrimmed(item.label) ?? `${kindLabel} +${Math.round(inSec)}s`;
    cleaned.push({ kind, inSec, label });
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_OP_PRESETS;
}

function readAttrFlag(el, attrName, camelKey) {
  if (!el || typeof el !== 'object') return false;
  if (el.dataset && el.dataset[camelKey] === 'true') return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute(attrName) === 'true') return true;
  return false;
}

function resolveMediaQueryList(matchMediaOverride) {
  const fn =
    typeof matchMediaOverride === 'function'
      ? matchMediaOverride
      : typeof globalThis.window?.matchMedia === 'function'
        ? globalThis.window.matchMedia.bind(globalThis.window)
        : typeof globalThis.matchMedia === 'function'
          ? globalThis.matchMedia.bind(globalThis)
          : null;
  if (!fn) return null;
  try {
    return fn(REDUCED_MOTION_QUERY) || null;
  } catch {
    return null;
  }
}

function arraysShallowEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function mountRunwayClashBoard(containerEl, rawOptions = {}) {
  if (!isMountableContainer(containerEl)) {
    return createUnmountedController();
  }

  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const doc =
    options.document ??
    containerEl.ownerDocument ??
    (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    return createUnmountedController();
  }

  const previous = mountedBoards.get(containerEl);
  if (previous) {
    previous.destroy();
    mountedBoards.delete(containerEl);
  }

  const readNow = typeof options.now === 'function' ? options.now : () => Date.now();
  const store = options.store && typeof options.store.activeOperations === 'function'
    ? options.store
    : createRunwayOpsStore({ now: readNow });

  const getAirportFn = typeof options.getAirport === 'function' ? options.getAirport : null;
  const getForecastsFn = typeof options.getForecasts === 'function' ? options.getForecasts : null;
  const onClashChange = typeof options.onClashChange === 'function' ? options.onClashChange : null;
  const tickIntervalMs =
    Number.isFinite(options.tickIntervalMs) && options.tickIntervalMs > 0
      ? options.tickIntervalMs
      : COUNTDOWN_INTERVAL_MS;
  const setIntervalImpl =
    typeof options.setInterval === 'function'
      ? options.setInterval
      : typeof globalThis.setInterval === 'function'
        ? globalThis.setInterval.bind(globalThis)
        : null;
  const clearIntervalImpl =
    typeof options.clearInterval === 'function'
      ? options.clearInterval
      : typeof globalThis.clearInterval === 'function'
        ? globalThis.clearInterval.bind(globalThis)
        : null;

  let explicitAirport =
    typeof options.airport === 'string' ? normalizeAirportCode(options.airport) : null;
  let latestForecasts =
    options.forecasts !== undefined
      ? options.forecasts
      : options.forecastsByCamera !== undefined
        ? options.forecastsByCamera
        : undefined;

  const hasExplicitMotionOpt = typeof options.reducedMotion === 'boolean';
  const mediaQuery = hasExplicitMotionOpt ? null : resolveMediaQueryList(options.matchMedia);
  let reducedMotion = hasExplicitMotionOpt
    ? options.reducedMotion
    : Boolean(mediaQuery?.matches) ||
      readAttrFlag(containerEl, 'data-reduced-motion', 'reducedMotion') ||
      readAttrFlag(doc.documentElement, 'data-reduced-motion', 'reducedMotion');

  const cleanups = [];
  const rowCache = new Map(); // op.id -> { rowEl, badgeEl, metaEl, countdownEl, cleanup }
  const cardCache = new Map(); // clash.key -> { rowEl, mainEl, metaEl }
  let renderedOpIds = [];
  let renderedClashKeys = [];
  let currentOperations = [];
  let currentClashes = [];
  let lastClashSignature = '';
  let surveyedCorridorActive = false;
  let tickTimer = null;
  let isRefreshing = false;
  let destroyed = false;

  // ---------- Build board DOM ----------
  const boardEl = createEl(doc, 'section', 'sky-clash-board');
  setAttr(boardEl, 'aria-label', 'Runway operations and trajectory clash advisory');

  const headEl = createEl(doc, 'div', 'sky-clash-head');
  const titleEl = createEl(doc, 'h3', 'sky-clash-title');
  titleEl.textContent = nonEmptyTrimmed(options.title) ?? 'Runway Operations & Clash Advisory';

  const airportPillEl = createEl(doc, 'span', 'sky-clash-airport-pill');
  const clearBtn = createEl(doc, 'button', 'sky-clash-clear-btn');
  clearBtn.type = 'button';
  setAttr(clearBtn, 'type', 'button');
  clearBtn.textContent = 'Clear';
  setDisabled(clearBtn, true);
  appendNodes(headEl, titleEl, airportPillEl, clearBtn);

  const controlsEl = createEl(doc, 'div', 'sky-clash-controls');
  const fieldsEl = createEl(doc, 'div', 'sky-clash-fields');

  const callsignLabel = createEl(doc, 'label');
  const callsignLabelText = createEl(doc, 'span');
  callsignLabelText.textContent = 'Callsign';
  const callsignInput = createEl(doc, 'input', 'sky-clash-input');
  callsignInput.type = 'text';
  callsignInput.name = 'callsign';
  callsignInput.value = '';
  callsignInput.placeholder = 'e.g. UAL412';
  setAttr(callsignInput, 'type', 'text');
  setAttr(callsignInput, 'name', 'callsign');
  setAttr(callsignInput, 'maxlength', '16');
  setAttr(callsignInput, 'autocomplete', 'off');
  setAttr(callsignInput, 'placeholder', 'e.g. UAL412');
  setData(callsignInput, 'field', 'callsign');
  appendNodes(callsignLabel, callsignLabelText, callsignInput);

  const runwayLabel = createEl(doc, 'label');
  const runwayLabelText = createEl(doc, 'span');
  runwayLabelText.textContent = 'Runway';
  const runwayInput = createEl(doc, 'input', 'sky-clash-input');
  runwayInput.type = 'text';
  runwayInput.name = 'runway';
  runwayInput.value = '';
  runwayInput.placeholder = 'e.g. 27L';
  setAttr(runwayInput, 'type', 'text');
  setAttr(runwayInput, 'name', 'runway');
  setAttr(runwayInput, 'maxlength', '8');
  setAttr(runwayInput, 'autocomplete', 'off');
  setAttr(runwayInput, 'placeholder', 'e.g. 27L');
  setData(runwayInput, 'field', 'runway');
  appendNodes(runwayLabel, runwayLabelText, runwayInput);

  appendNodes(fieldsEl, callsignLabel, runwayLabel);

  const presetsEl = createEl(doc, 'div', 'sky-clash-presets');
  setAttr(presetsEl, 'role', 'group');
  setAttr(presetsEl, 'aria-label', 'Quick runway operation presets');

  const presets = normalizePresets(options.presets);
  const presetButtons = [];
  for (const preset of presets) {
    const btn = createEl(doc, 'button', 'sky-clash-preset-btn');
    btn.type = 'button';
    setAttr(btn, 'type', 'button');
    setData(btn, 'kind', preset.kind);
    setData(btn, 'opKind', preset.kind);
    setData(btn, 'inSec', String(preset.inSec));
    btn.textContent = preset.label;
    cleanups.push(
      listen(btn, 'click', () => {
        if (destroyed) return;
        const created = logOperation(preset.kind, preset.inSec);
        if (created) {
          callsignInput.value = '';
        }
      }),
    );
    presetButtons.push(btn);
  }
  appendNodes(presetsEl, ...presetButtons);
  appendNodes(controlsEl, fieldsEl, presetsEl);

  const emptyEl = createEl(doc, 'p', 'sky-clash-empty');
  emptyEl.textContent = 'No scheduled departures or arrivals logged.';

  const opsListEl = createEl(doc, 'ul', 'sky-clash-ops');
  setAttr(opsListEl, 'aria-label', 'Scheduled runway operations');

  const bannerEl = createEl(doc, 'div', 'sky-clash-banner');
  setAttr(bannerEl, 'role', 'region');
  setAttr(bannerEl, 'aria-live', 'polite');
  setAttr(bannerEl, 'aria-label', 'Runway trajectory clash advisory');
  setData(bannerEl, 'clashState', 'clear');

  const bannerHeadEl = createEl(doc, 'div', 'sky-clash-banner-head');
  const pulseDotEl = createEl(doc, 'span', 'sky-clash-pulse-dot');
  setAttr(pulseDotEl, 'aria-hidden', 'true');
  const bannerTitleEl = createEl(doc, 'p', 'sky-clash-banner-title');
  appendNodes(bannerHeadEl, pulseDotEl, bannerTitleEl);

  const disclaimerEl = createEl(doc, 'p', 'sky-clash-disclaimer');
  disclaimerEl.textContent = CLASH_ADVISORY_DISCLAIMER;

  const clashListEl = createEl(doc, 'ul', 'sky-clash-list');
  setAttr(clashListEl, 'aria-live', 'polite');
  setAttr(clashListEl, 'aria-label', 'Active trajectory clash warnings');

  appendNodes(bannerEl, bannerHeadEl, disclaimerEl, clashListEl);
  appendNodes(boardEl, headEl, controlsEl, emptyEl, opsListEl, bannerEl);

  // ---------- Event wiring ----------
  cleanups.push(
    listen(clearBtn, 'click', () => {
      if (destroyed) return;
      clearOperations();
    }),
  );

  if (mediaQuery) {
    const onMotionChange = event => {
      if (destroyed) return;
      reducedMotion = Boolean(event?.matches ?? mediaQuery.matches);
      syncReducedMotionAttr();
    };
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onMotionChange);
      cleanups.push(() => mediaQuery.removeEventListener?.('change', onMotionChange));
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onMotionChange);
      cleanups.push(() => mediaQuery.removeListener?.(onMotionChange));
    }
  }

  if (typeof store.subscribe === 'function') {
    const unsubscribe = store.subscribe(() => {
      if (!destroyed && !isRefreshing) {
        refresh();
      }
    });
    if (typeof unsubscribe === 'function') {
      cleanups.push(unsubscribe);
    }
  }

  function syncReducedMotionAttr() {
    if (!hasExplicitMotionOpt && !mediaQuery) {
      reducedMotion =
        readAttrFlag(containerEl, 'data-reduced-motion', 'reducedMotion') ||
        readAttrFlag(doc.documentElement, 'data-reduced-motion', 'reducedMotion');
    }
    setData(boardEl, 'reducedMotion', reducedMotion ? 'true' : null);
  }

  function resolveAirport() {
    if (explicitAirport !== null) return explicitAirport;
    if (getAirportFn) return normalizeAirportCode(getAirportFn());
    return '';
  }

  function resolveForecastSnapshot() {
    if (latestForecasts !== undefined) return latestForecasts;
    if (getForecastsFn) return getForecastsFn();
    return null;
  }

  function stopCountdownTimer() {
    if (tickTimer !== null) {
      const handle = tickTimer;
      tickTimer = null;
      if (clearIntervalImpl) {
        clearIntervalImpl(handle);
      }
    }
  }

  function syncCountdownTimer(hasActiveOps) {
    if (destroyed || !hasActiveOps) {
      stopCountdownTimer();
      return;
    }
    if (tickTimer === null && setIntervalImpl) {
      const handle = setIntervalImpl(() => {
        if (!destroyed) refresh();
      }, tickIntervalMs);
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') {
        handle.unref();
      }
      tickTimer = handle;
    }
  }

  function ensureOpRow(op) {
    let entry = rowCache.get(op.id);
    const metaText = formatOperationMeta(op);
    const countdownText = formatCountdownSec(op.inSec);
    const badgeLabel = op.kind === 'arrival' ? 'Arrival' : 'Departure';

    if (!entry) {
      const rowEl = createEl(doc, 'li', 'sky-clash-op-row');
      const badgeEl = createEl(doc, 'span', 'sky-clash-kind-badge');
      const metaEl = createEl(doc, 'span', 'sky-clash-op-meta');
      const countdownEl = createEl(doc, 'span', 'sky-clash-countdown');
      const removeBtn = createEl(doc, 'button', 'sky-clash-op-remove');
      removeBtn.type = 'button';
      setAttr(removeBtn, 'type', 'button');
      removeBtn.textContent = 'Remove';

      const opId = op.id;
      const cleanup = listen(removeBtn, 'click', () => {
        if (!destroyed) removeOperation(opId);
      });

      appendNodes(rowEl, badgeEl, metaEl, countdownEl, removeBtn);
      entry = { rowEl, badgeEl, metaEl, countdownEl, removeBtn, cleanup };
      rowCache.set(op.id, entry);
    }

    setData(entry.rowEl, 'kind', op.kind);
    setData(entry.rowEl, 'opId', op.id);
    setData(entry.badgeEl, 'kind', op.kind);
    if (entry.badgeEl.textContent !== badgeLabel) entry.badgeEl.textContent = badgeLabel;
    if (entry.metaEl.textContent !== metaText) entry.metaEl.textContent = metaText;
    if (entry.countdownEl.textContent !== countdownText) entry.countdownEl.textContent = countdownText;
    setAttr(entry.removeBtn, 'aria-label', `Remove ${op.kind} ${metaText}`);

    return entry.rowEl;
  }

  function syncOperationsDom(ops, hasAirport) {
    setDisabled(clearBtn, !hasAirport || ops.length === 0);
    setDisabled(callsignInput, !hasAirport);
    setDisabled(runwayInput, !hasAirport);
    for (const btn of presetButtons) {
      setDisabled(btn, !hasAirport);
    }

    setVisible(emptyEl, ops.length === 0);
    setVisible(opsListEl, ops.length > 0);

    const nextIds = ops.map(op => op.id);
    const nextIdSet = new Set(nextIds);
    for (const [cachedId, cachedEntry] of [...rowCache.entries()]) {
      if (!nextIdSet.has(cachedId)) {
        cachedEntry.cleanup();
        rowCache.delete(cachedId);
      }
    }

    const nextRowNodes = ops.map(ensureOpRow);
    const currentChildCount = Array.isArray(opsListEl.children) ? opsListEl.children.length : -1;
    if (!arraysShallowEqual(renderedOpIds, nextIds) || (currentChildCount !== -1 && currentChildCount !== nextRowNodes.length)) {
      replaceNodeChildren(opsListEl, nextRowNodes);
      renderedOpIds = nextIds;
    }
  }

  function ensureClashCard(clash) {
    let entry = cardCache.get(clash.key);
    if (!entry) {
      const rowEl = createEl(doc, 'li', 'sky-clash-alert-row');
      const mainEl = createEl(doc, 'div', 'sky-clash-alert-main');
      const metaEl = createEl(doc, 'div', 'sky-clash-alert-meta');
      appendNodes(rowEl, mainEl, metaEl);
      entry = { rowEl, mainEl, metaEl };
      cardCache.set(clash.key, entry);
    }

    const severity = clash.severity === 'amber' ? 'amber' : 'red';
    const headline = formatClashHeadline(clash);
    const meta = formatClashMeta(clash);

    setData(entry.rowEl, 'severity', severity);
    setData(entry.rowEl, 'clashKey', clash.key);
    setData(entry.rowEl, 'cameraId', clash.cameraId);
    setData(entry.rowEl, 'operationId', clash.operationId);
    if (entry.mainEl.textContent !== headline) entry.mainEl.textContent = headline;
    if (entry.metaEl.textContent !== meta) entry.metaEl.textContent = meta;

    return entry.rowEl;
  }

  function syncBannerDom(normAirport, ops, clashes, hasSurveyed) {
    let bannerState = 'clear';
    if (clashes.length > 0) {
      bannerState = clashes.some(c => c.severity === 'red') ? 'red' : 'amber';
    }
    setData(bannerEl, 'clashState', bannerState);
    setData(bannerEl, 'corridorStatus', hasSurveyed ? 'surveyed' : 'unsurveyed');

    let statusTitle;
    if (!normAirport) {
      statusTitle = 'Select an airport to monitor surveyed corridor trajectory overlaps';
    } else if (!hasSurveyed) {
      statusTitle = NO_SURVEYED_CORRIDOR_NOTE;
    } else if (clashes.length > 0) {
      statusTitle = `${clashes.length} advisory trajectory ${clashes.length === 1 ? 'clash' : 'clashes'} detected`;
    } else if (ops.length === 0) {
      statusTitle = 'Surveyed corridor active — log a departure or arrival to check overlaps';
    } else {
      statusTitle = 'No trajectory overlaps predicted for scheduled runway operations';
    }
    if (bannerTitleEl.textContent !== statusTitle) {
      bannerTitleEl.textContent = statusTitle;
    }

    setVisible(clashListEl, clashes.length > 0);
    const nextKeys = clashes.map(c => c.key);
    const nextKeySet = new Set(nextKeys);
    for (const cachedKey of [...cardCache.keys()]) {
      if (!nextKeySet.has(cachedKey)) {
        cardCache.delete(cachedKey);
      }
    }

    const nextCardNodes = clashes.map(ensureClashCard);
    const currentChildCount = Array.isArray(clashListEl.children) ? clashListEl.children.length : -1;
    if (!arraysShallowEqual(renderedClashKeys, nextKeys) || (currentChildCount !== -1 && currentChildCount !== nextCardNodes.length)) {
      replaceNodeChildren(clashListEl, nextCardNodes);
      renderedClashKeys = nextKeys;
    }
  }

  function refresh() {
    if (destroyed) {
      return {
        airport: '',
        operations: [],
        clashes: [],
        surveyedCorridor: false,
      };
    }

    isRefreshing = true;
    try {
      syncReducedMotionAttr();

      const normAirport = resolveAirport();
      const refMs = readNow();
      setData(boardEl, 'airport', normAirport || null);
      airportPillEl.textContent = normAirport || 'NO AIRPORT';

      const ops = normAirport ? store.activeOperations(normAirport, refMs) : [];
      currentOperations = ops;

      const snapshot = resolveForecastSnapshot();
      const { surveyedCameraCount, sanitizedByCamera } = sanitizeForecastSources(snapshot, normAirport);
      surveyedCorridorActive = surveyedCameraCount > 0;

      let clashes = [];
      if (normAirport && surveyedCorridorActive && ops.length > 0 && sanitizedByCamera?.size > 0) {
        const evaluated = store.evaluateClashes(sanitizedByCamera, normAirport, refMs);
        if (Array.isArray(evaluated)) {
          clashes = evaluated.filter(
            item =>
              item &&
              typeof item === 'object' &&
              !Boolean(item.demo) &&
              item.corridorSurveyed !== false &&
              Boolean(nonEmptyTrimmed(item.surveyId)),
          );
        }
      }
      currentClashes = clashes;

      syncOperationsDom(ops, Boolean(normAirport));
      syncBannerDom(normAirport, ops, clashes, surveyedCorridorActive);
      syncCountdownTimer(ops.length > 0);

      if (onClashChange) {
        const sig = clashes.map(c => `${c.key}:${c.severity}`).join('|');
        if (sig !== lastClashSignature) {
          lastClashSignature = sig;
          onClashChange([...clashes]);
        }
      }

      return {
        airport: normAirport,
        operations: [...ops],
        clashes: [...clashes],
        surveyedCorridor: surveyedCorridorActive,
      };
    } finally {
      isRefreshing = false;
    }
  }

  function setAirport(nextAirport) {
    if (destroyed) return '';
    if ((nextAirport === null || nextAirport === undefined) && getAirportFn) {
      explicitAirport = null;
    } else {
      explicitAirport = normalizeAirportCode(typeof nextAirport === 'string' ? nextAirport : '');
    }
    refresh();
    return resolveAirport();
  }

  function updateForecasts(nextForecasts) {
    if (destroyed) return [];
    latestForecasts = nextForecasts;
    refresh();
    return [...currentClashes];
  }

  function logOperation(opOrKind, maybeInSec, maybeMeta = {}) {
    if (destroyed) return null;
    const normAirport = resolveAirport();
    if (!normAirport) return null;

    const spec =
      opOrKind && typeof opOrKind === 'object'
        ? opOrKind
        : {
            ...(maybeMeta && typeof maybeMeta === 'object' ? maybeMeta : {}),
            kind: opOrKind,
            inSec: maybeInSec,
          };

    const kind = spec.kind;
    const inSec = Number(spec.inSec);
    if ((kind !== 'departure' && kind !== 'arrival') || !Number.isFinite(inSec) || inSec <= 0) {
      return null;
    }

    const callsign =
      spec.callsign !== undefined
        ? String(spec.callsign ?? '')
        : typeof callsignInput.value === 'string'
          ? callsignInput.value
          : '';
    const runway =
      spec.runway !== undefined
        ? String(spec.runway ?? '')
        : typeof runwayInput.value === 'string'
          ? runwayInput.value
          : '';

    const added = store.addOperation({
      airport: normAirport,
      kind,
      inSec,
      callsign,
      runway,
      nowMs: readNow(),
    });
    refresh();
    return added;
  }

  function removeOperation(id) {
    if (destroyed || typeof store.removeOperation !== 'function') return false;
    const removed = store.removeOperation(id);
    if (removed) refresh();
    return removed;
  }

  function clearOperations() {
    if (destroyed || typeof store.clear !== 'function') return;
    const normAirport = resolveAirport();
    if (!normAirport) return;
    store.clear(normAirport);
    refresh();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopCountdownTimer();
    for (const cachedEntry of rowCache.values()) {
      cachedEntry.cleanup();
    }
    rowCache.clear();
    cardCache.clear();
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch {
        // Best-effort listener teardown.
      }
    }
    detachFromContainer(containerEl, boardEl);
    if (mountedBoards.get(containerEl) === controller) {
      mountedBoards.delete(containerEl);
    }
  }

  appendNodes(containerEl, boardEl);
  refresh();

  const controller = {
    element: boardEl,
    store,
    setAirport,
    getAirport: () => (destroyed ? '' : resolveAirport()),
    updateForecasts,
    logOperation,
    removeOperation,
    clearOperations,
    getActiveOperations: () => {
      if (destroyed) return [];
      const normAirport = resolveAirport();
      return normAirport ? store.activeOperations(normAirport, readNow()) : [];
    },
    getClashes: () => (destroyed ? [] : [...currentClashes]),
    hasSurveyedCorridor: () => (destroyed ? false : surveyedCorridorActive),
    isReducedMotion: () => reducedMotion,
    refresh,
    destroy,
  };

  mountedBoards.set(containerEl, controller);
  return controller;
}

export const createRunwayClashBoard = mountRunwayClashBoard;
