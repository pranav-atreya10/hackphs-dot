// Ephemeral per-airport runway departure/arrival schedule store & trajectory clash evaluator.
//
// Pure advisory module for Runway Clash Board & HUD trajectory overlap warnings:
//   - Zero browser global dependencies at import or call time (runs cleanly in Node and browsers).
//   - Strictly bounds tracked airport buckets and operations per airport.
//   - Evaluates trajectory overlaps ONLY against cameras/forecasts with surveyed corridors
//     (`corridorSurveyed === true`, non-demo); uncalibrated feeds emit zero clashes.

export const DEFAULT_MAX_OPS = 12;
export const OP_BUFFER_SEC = 20;
export const VALID_OP_KINDS = Object.freeze(['departure', 'arrival']);

const DEFAULT_MAX_AIRPORTS = 64;
const MAX_OP_IN_SEC = 3600;
const CLASH_MIN_P60 = 0.15;

export function normalizeAirportCode(airport) {
  if (typeof airport !== 'string') return '';
  return airport.trim().toUpperCase();
}

export function createRunwayOpsStore(rawOpts = {}) {
  if (rawOpts === null || typeof rawOpts !== 'object') {
    throw new TypeError('RunwayOpsStore options must be an object');
  }
  const {
    maxOps = DEFAULT_MAX_OPS,
    now = Date.now,
    maxAirports = DEFAULT_MAX_AIRPORTS,
  } = rawOpts;

  if (!Number.isSafeInteger(maxOps) || maxOps <= 0) {
    throw new RangeError('maxOps must be a positive safe integer');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (!Number.isSafeInteger(maxAirports) || maxAirports <= 0) {
    throw new RangeError('maxAirports must be a positive safe integer');
  }

  const buckets = new Map(); // normAirport -> Array<StoredOp>
  const listeners = new Set();
  let seq = 0;

  function resolveNowMs(nowMs) {
    const t = Number.isFinite(nowMs) ? nowMs : now();
    if (!Number.isFinite(t)) {
      throw new RangeError('now() must return a finite timestamp in milliseconds');
    }
    return t;
  }

  function notify() {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function pruneBucket(airportCode, list, refMs) {
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].dueAtMs > refMs) {
        list[write++] = list[i];
      }
    }
    list.length = write;
    if (list.length === 0) {
      buckets.delete(airportCode);
    }
  }

  function pruneAllExpiredBuckets(refMs) {
    for (const [airportCode, list] of [...buckets.entries()]) {
      pruneBucket(airportCode, list, refMs);
    }
  }

  function evictEarliestDue(list) {
    if (list.length === 0) return;
    let victimIdx = 0;
    for (let i = 1; i < list.length; i++) {
      const cand = list[i];
      const best = list[victimIdx];
      if (cand.dueAtMs < best.dueAtMs || (cand.dueAtMs === best.dueAtMs && cand.seq < best.seq)) {
        victimIdx = i;
      }
    }
    list.splice(victimIdx, 1);
  }

  function addOperation(rawOp = {}) {
    if (rawOp === null || typeof rawOp !== 'object') {
      throw new TypeError('operation must be an object');
    }
    const {
      airport,
      kind,
      callsign = '',
      runway = '',
      inSec,
      nowMs,
    } = rawOp;

    const normAirport = normalizeAirportCode(airport);
    if (!normAirport) {
      throw new RangeError('airport must be a non-empty string');
    }
    if (kind !== 'departure' && kind !== 'arrival') {
      throw new RangeError('kind must be "departure" or "arrival"');
    }
    if (!Number.isFinite(inSec) || inSec <= 0) {
      throw new RangeError('inSec must be a positive finite number');
    }

    const boundedInSec = Math.min(inSec, MAX_OP_IN_SEC);
    const cleanCallsign = typeof callsign === 'string' ? callsign.trim().toUpperCase().slice(0, 16) : '';
    const cleanRunway = typeof runway === 'string' ? runway.trim().toUpperCase().slice(0, 8) : '';
    const createdAtMs = resolveNowMs(nowMs);
    const dueAtMs = createdAtMs + boundedInSec * 1000;

    let list = buckets.get(normAirport);
    if (list) {
      pruneBucket(normAirport, list, createdAtMs);
      list = buckets.get(normAirport);
    }
    if (!list) {
      if (buckets.size >= maxAirports) {
        pruneAllExpiredBuckets(createdAtMs);
        while (buckets.size >= maxAirports) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey === undefined) break;
          buckets.delete(oldestKey);
        }
      }
      list = [];
      buckets.set(normAirport, list);
    }

    while (list.length >= maxOps) {
      evictEarliestDue(list);
    }

    const opSeq = ++seq;
    const id = `rwy-op-${opSeq}`;
    const stored = {
      id,
      seq: opSeq,
      airport: normAirport,
      kind,
      callsign: cleanCallsign,
      runway: cleanRunway,
      inSec: boundedInSec,
      createdAtMs,
      dueAtMs,
    };
    list.push(stored);
    notify();

    return {
      id: stored.id,
      airport: stored.airport,
      kind: stored.kind,
      callsign: stored.callsign,
      runway: stored.runway,
      inSec: stored.inSec,
      createdAtMs: stored.createdAtMs,
      dueAtMs: stored.dueAtMs,
    };
  }

  function removeOperation(id) {
    if (typeof id !== 'string' || id.length === 0) return false;
    for (const [airportCode, list] of buckets.entries()) {
      const idx = list.findIndex(op => op.id === id);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) {
          buckets.delete(airportCode);
        }
        notify();
        return true;
      }
    }
    return false;
  }

  function clear(airport) {
    if (airport === undefined || airport === null) {
      let hadAny = false;
      for (const list of buckets.values()) {
        if (list.length > 0) {
          hadAny = true;
          break;
        }
      }
      buckets.clear();
      if (hadAny) notify();
      return;
    }

    const normAirport = normalizeAirportCode(airport);
    if (!normAirport) return;
    const existing = buckets.get(normAirport);
    const hadOps = Boolean(existing && existing.length > 0);
    buckets.delete(normAirport);
    if (hadOps) notify();
  }

  function activeOperations(airport, nowMs = now()) {
    const normAirport = normalizeAirportCode(airport);
    if (!normAirport) return [];
    const list = buckets.get(normAirport);
    if (!list || list.length === 0) return [];

    const refMs = resolveNowMs(nowMs);
    pruneBucket(normAirport, list, refMs);
    if (list.length === 0) return [];

    list.sort((a, b) => a.dueAtMs - b.dueAtMs || a.seq - b.seq);
    return list.map(op => {
      const rounded = Math.round(((op.dueAtMs - refMs) / 1000) * 1000) / 1000;
      return {
        id: op.id,
        kind: op.kind,
        callsign: op.callsign,
        runway: op.runway,
        inSec: rounded > 0 ? rounded : 0.001,
      };
    });
  }

  function evaluateClashes(forecastsByCamera, airport, nowMs = now()) {
    const normAirport = normalizeAirportCode(airport);
    if (!normAirport) return [];
    const refMs = resolveNowMs(nowMs);
    const ops = activeOperations(normAirport, refMs);
    if (ops.length === 0 || !forecastsByCamera || typeof forecastsByCamera !== 'object') {
      return [];
    }

    const cameraEntries = extractCameraEntries(forecastsByCamera);
    const clashesByKey = new Map();

    for (const [entryKey, src] of cameraEntries) {
      const resolved = resolveCameraForecasts(entryKey, src, normAirport, ops);
      if (!resolved) continue;
      const { cameraId, cameraLabel, srcSurveyId, forecasts, authoritativeClashes } = resolved;

      for (const f of forecasts) {
        if (!f || typeof f !== 'object' || f.corridorSurveyed !== true || f.demo === true) {
          continue;
        }
        if (!isValidTrackId(f.id)) continue;

        const inside0 = f.straight_line_eta_sec === 0 ||
          Boolean(f.eta && f.eta.p10 === 0 && f.eta.p90 === 0) ||
          /in the corridor now/i.test(f.reason || '');
        const hasEta = Boolean(f.eta && Number.isFinite(f.eta.p10) && Number.isFinite(f.eta.p90));
        const rawP60 = f.pWithin?.[60] ?? f.p_enter?.within_60s ?? 0;
        const p60 = Number.isFinite(rawP60) ? rawP60 : 0;
        const lo = inside0 ? 0 : (hasEta ? f.eta.p10 : 0);
        const hi = inside0 ? OP_BUFFER_SEC : (hasEta ? f.eta.p90 : OP_BUFFER_SEC);
        const existingClashes = Array.isArray(f.clashes) ? f.clashes : null;

        for (const op of ops) {
          const matched = existingClashes ? findMatchingClash(existingClashes, op) : null;
          let clashes = Boolean(matched);

          if (!clashes && !(authoritativeClashes && existingClashes)) {
            if ((hasEta || inside0) && (inside0 || p60 >= CLASH_MIN_P60)) {
              if (op.inSec >= lo - OP_BUFFER_SEC && op.inSec <= hi + OP_BUFFER_SEC) {
                clashes = true;
              }
            }
          }
          if (!clashes) continue;

          const key = `${cameraId}:${f.id}:${op.id}`;
          if (clashesByKey.has(key)) continue;

          const existingMessage = typeof matched?.message === 'string' && matched.message.trim()
            ? matched.message
            : '';
          const rawP30 = f.pWithin?.[30] ?? f.p_enter?.within_30s;
          const rawOutP60 = f.pWithin?.[60] ?? f.p_enter?.within_60s;
          const severity = matched?.severity === 'amber' || f.severity === 'amber' ? 'amber' : 'red';

          clashesByKey.set(key, {
            key,
            airport: normAirport,
            cameraId: String(cameraId),
            cameraLabel: String(cameraLabel || cameraId),
            surveyId: nonEmptyTrimmed(f.surveyId) ?? srcSurveyId ?? null,
            trackId: f.id,
            cls: f.cls || 'other',
            severity,
            level: f.level === 'yellow' ? 'red' : (f.level || 'red'),
            operationId: op.id,
            kind: op.kind,
            callsign: op.callsign || '',
            runway: op.runway || '',
            inSec: op.inSec,
            eta: f.eta && typeof f.eta === 'object'
              ? { p10: f.eta.p10, p50: f.eta.p50, p90: f.eta.p90 }
              : null,
            pWithin30: Number.isFinite(rawP30) ? rawP30 : null,
            pWithin60: Number.isFinite(rawOutP60) ? rawOutP60 : null,
            message: existingMessage ||
              `${op.kind} in ${Math.round(op.inSec)} s may meet this ${f.cls || 'object'} (likely in corridor ${Math.round(lo)}-${Math.round(hi)} s)`,
            advisory: true,
          });
        }
      }
    }

    return [...clashesByKey.values()].sort(compareClashes);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function count(airport, nowMs = now()) {
    return activeOperations(airport, nowMs).length;
  }

  return {
    addOperation,
    removeOperation,
    clear,
    activeOperations,
    evaluateClashes,
    subscribe,
    count,
  };
}

function extractCameraEntries(forecastsByCamera) {
  if (forecastsByCamera instanceof Map) {
    return [...forecastsByCamera.entries()];
  }
  if (Array.isArray(forecastsByCamera)) {
    const out = [];
    for (let i = 0; i < forecastsByCamera.length; i++) {
      const item = forecastsByCamera[i];
      if (!item || typeof item !== 'object') continue;
      const key = nonEmptyTrimmed(item.cameraId) ?? nonEmptyTrimmed(item.id) ?? `camera-${i}`;
      out.push([key, item]);
    }
    return out;
  }
  return Object.entries(forecastsByCamera);
}

function resolveCameraForecasts(entryKey, src, normAirport, ops) {
  if (!src || typeof src !== 'object') return null;

  if (Array.isArray(src)) {
    const cameraId = String(entryKey);
    return {
      cameraId,
      cameraLabel: cameraId,
      srcSurveyId: null,
      forecasts: src,
      authoritativeClashes: false,
    };
  }

  if (typeof src.airport === 'string') {
    const srcAirport = normalizeAirportCode(src.airport);
    if (srcAirport && srcAirport !== normAirport) return null;
  }

  if (src.demo === true || src.surveyedCorridor === false || src.corridorSurveyed === false) {
    return null;
  }
  if (src.corridor && typeof src.corridor === 'object' && !Array.isArray(src.corridor)) {
    if (src.corridor.demo === true || src.corridor.surveyed === false) return null;
  }

  const cameraId = nonEmptyStringId(src.cameraId) ?? String(entryKey);
  const cameraLabel = nonEmptyTrimmed(src.cameraLabel) ?? cameraId;

  if (typeof src.forecastAll === 'function' && typeof src.hasCorridor === 'function') {
    if (src.hasCorridor() !== true) return null;
    const forecasts = src.forecastAll({ operations: ops });
    if (!Array.isArray(forecasts)) return null;
    return {
      cameraId,
      cameraLabel,
      srcSurveyId: nonEmptyTrimmed(src.surveyId),
      forecasts,
      authoritativeClashes: Boolean(src.cfg && typeof src.cfg === 'object'),
    };
  }

  if (src.forecaster && typeof src.forecaster.forecastAll === 'function') {
    if (src.forecaster.hasCorridor?.() !== true) return null;
    const forecasts = src.forecaster.forecastAll({ operations: ops });
    if (!Array.isArray(forecasts)) return null;
    return {
      cameraId,
      cameraLabel,
      srcSurveyId: nonEmptyTrimmed(src.surveyId) ?? nonEmptyTrimmed(src.forecaster.surveyId),
      forecasts,
      authoritativeClashes: Boolean(src.forecaster.cfg && typeof src.forecaster.cfg === 'object'),
    };
  }

  if (Array.isArray(src.forecasts)) {
    return {
      cameraId,
      cameraLabel,
      srcSurveyId: nonEmptyTrimmed(src.surveyId),
      forecasts: src.forecasts,
      authoritativeClashes: false,
    };
  }

  return null;
}

function findMatchingClash(existingClashes, op) {
  for (let i = 0; i < existingClashes.length; i++) {
    const c = existingClashes[i];
    if (!c || typeof c !== 'object') continue;
    if (c.id !== undefined && c.id !== null && c.id !== '') {
      if (c.id === op.id) return c;
    } else if (
      c.kind === op.kind &&
      (c.runway || '') === (op.runway || '') &&
      Number.isFinite(c.inSec) &&
      Math.abs(c.inSec - op.inSec) < 1e-3
    ) {
      return c;
    }
  }
  return null;
}

function compareClashes(a, b) {
  const sevDiff = severityOrder(a.severity) - severityOrder(b.severity);
  if (sevDiff !== 0) return sevDiff;
  const secDiff = a.inSec - b.inSec;
  if (secDiff !== 0) return secDiff;
  const aP60 = Number.isFinite(a.pWithin60) ? a.pWithin60 : -1;
  const bP60 = Number.isFinite(b.pWithin60) ? b.pWithin60 : -1;
  if (bP60 !== aP60) return bP60 - aP60;
  return a.key.localeCompare(b.key);
}

function severityOrder(severity) {
  if (severity === 'red') return 0;
  if (severity === 'amber' || severity === 'yellow') return 1;
  return 2;
}

function isValidTrackId(id) {
  return (typeof id === 'number' && Number.isFinite(id)) ||
    (typeof id === 'string' && id.length > 0);
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
