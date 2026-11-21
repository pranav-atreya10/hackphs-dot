const { isDeviceId, isLiveSource } = require("./camera-ingress");

const ACOUSTIC_TTL_MS = 3000;
const MAX_STOPPED_SESSIONS = 1000;
const MAX_STRING_LENGTH = 128;

const INACTIVE_ACOUSTIC_STATE = Object.freeze({
  active: false,
  droneProb: 0,
  dominantHz: 0,
  humDetected: false,
  updatedAt: null,
});

const SUMMARY_KEYS = new Set([
  "source",
  "streamId",
  "t",
  "droneProb",
  "dominantHz",
  "harmonicRatio",
  "rmsDb",
  "humDetected",
]);

const FORBIDDEN_AUDIO_KEYS = new Set([
  "pcm",
  "samples",
  "sample",
  "audio",
  "audiobuffer",
  "waveform",
  "frames",
  "chunks",
  "blob",
  "raw",
  "data",
  "bytes",
  "buffer",
  "spectrum",
  "fft",
  "bins",
  "base64",
  "opus",
  "wav",
  "webm",
  "mp3",
  "ogg",
  "flac",
  "aac",
  "transcript",
  "speech",
  "voice",
  "recording",
  "media",
]);

const DATA_AUDIO_URI_RE = /^\s*data:audio(?:\/|;|,|\b)/i;

function isBinaryAudioValue(v) {
  if (v === null || typeof v !== "object") return false;
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) return true;
  if (typeof Blob !== "undefined" && v instanceof Blob) return true;
  const tag = Object.prototype.toString.call(v);
  return (
    tag === "[object ArrayBuffer]" ||
    tag === "[object SharedArrayBuffer]" ||
    tag === "[object Blob]" ||
    tag === "[object AudioBuffer]" ||
    tag === "[object File]"
  );
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v) || isBinaryAudioValue(v)) return false;
  if (v instanceof Date || v instanceof RegExp || v instanceof Map || v instanceof Set) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype || Object.prototype.toString.call(v) === "[object Object]";
}

function isForbiddenAudioKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  const lower = key.toLowerCase();
  if (FORBIDDEN_AUDIO_KEYS.has(lower)) return true;
  const collapsed = lower.replace(/[^a-z0-9]/g, "");
  if (FORBIDDEN_AUDIO_KEYS.has(collapsed)) return true;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return tokens.some(token => token.length > 0 && FORBIDDEN_AUDIO_KEYS.has(token));
}

// Bystander speech privacy guard: rejects raw PCM, typed arrays, binary buffers,
// sample/FFT arrays, audio media fields, data:audio URIs, and oversized strings.
function hasForbiddenRawAudio(payload) {
  const visited = new Set();
  function scan(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") {
      return value.length > MAX_STRING_LENGTH || DATA_AUDIO_URI_RE.test(value);
    }
    if (typeof value !== "object") return false;
    if (isBinaryAudioValue(value) || Array.isArray(value)) return true;
    if (visited.has(value)) return false;
    visited.add(value);
    if (value.type === "Buffer" && Array.isArray(value.data)) return true;
    for (const key of Object.keys(value)) {
      if (isForbiddenAudioKey(key) || scan(value[key])) return true;
    }
    return false;
  }
  return scan(payload);
}

function validateAcousticSummary(payload) {
  if (hasForbiddenRawAudio(payload)) return { ok: false, reason: "raw_audio_rejected" };
  if (!isPlainObject(payload)) return { ok: false, reason: "invalid_payload" };
  if (Object.getOwnPropertySymbols(payload).length > 0) return { ok: false, reason: "unexpected_field" };
  for (const key of Object.keys(payload)) {
    if (!SUMMARY_KEYS.has(key)) return { ok: false, reason: "unexpected_field" };
  }
  if (!Object.hasOwn(payload, "source") || !isLiveSource(payload.source)) {
    return { ok: false, reason: "non_live_source" };
  }
  if (
    !Object.hasOwn(payload, "streamId") ||
    typeof payload.streamId !== "string" ||
    payload.streamId.trim().length === 0 ||
    payload.streamId.length > MAX_STRING_LENGTH
  ) {
    return { ok: false, reason: "invalid_stream_id" };
  }
  if (!Object.hasOwn(payload, "t") || typeof payload.t !== "number" || !Number.isFinite(payload.t) || payload.t < 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (
    !Object.hasOwn(payload, "droneProb") ||
    typeof payload.droneProb !== "number" ||
    !Number.isFinite(payload.droneProb) ||
    payload.droneProb < 0 ||
    payload.droneProb > 1
  ) {
    return { ok: false, reason: "invalid_drone_prob" };
  }
  if (
    !Object.hasOwn(payload, "dominantHz") ||
    typeof payload.dominantHz !== "number" ||
    !Number.isFinite(payload.dominantHz) ||
    payload.dominantHz < 0 ||
    payload.dominantHz > 24000
  ) {
    return { ok: false, reason: "invalid_dominant_hz" };
  }
  if (
    !Object.hasOwn(payload, "harmonicRatio") ||
    typeof payload.harmonicRatio !== "number" ||
    !Number.isFinite(payload.harmonicRatio) ||
    payload.harmonicRatio < 0 ||
    payload.harmonicRatio > 1
  ) {
    return { ok: false, reason: "invalid_harmonic_ratio" };
  }
  if (
    !Object.hasOwn(payload, "rmsDb") ||
    typeof payload.rmsDb !== "number" ||
    !Number.isFinite(payload.rmsDb) ||
    payload.rmsDb < -160 ||
    payload.rmsDb > 6
  ) {
    return { ok: false, reason: "invalid_rms_db" };
  }
  if (!Object.hasOwn(payload, "humDetected") || typeof payload.humDetected !== "boolean") {
    return { ok: false, reason: "invalid_hum_detected" };
  }
  return {
    ok: true,
    summary: {
      source: "live",
      streamId: payload.streamId.trim(),
      t: payload.t || 0,
      droneProb: +payload.droneProb.toFixed(3) || 0,
      dominantHz: Math.round(payload.dominantHz) || 0,
      harmonicRatio: +payload.harmonicRatio.toFixed(3) || 0,
      rmsDb: +payload.rmsDb.toFixed(1) || 0,
      humDetected: payload.humDetected,
    },
  };
}

function validateStreamBinding(binding) {
  if (!isPlainObject(binding)) return { ok: false, reason: "invalid_binding" };
  if (binding.source !== undefined && !isLiveSource(binding.source)) {
    return { ok: false, reason: "non_live_source" };
  }
  if (binding.online === false || binding.stopped === true) {
    return { ok: false, reason: "stream_stopped" };
  }
  if (typeof binding.airport !== "string" || binding.airport.trim().length === 0) {
    return { ok: false, reason: "invalid_airport" };
  }
  if (typeof binding.cameraId !== "string" || binding.cameraId.trim().length === 0) {
    return { ok: false, reason: "invalid_camera_id" };
  }
  if (typeof binding.principal !== "string" || binding.principal.trim().length === 0) {
    return { ok: false, reason: "invalid_principal" };
  }
  if (!isDeviceId(binding.deviceId)) {
    return { ok: false, reason: "invalid_device_id" };
  }
  if (typeof binding.session !== "string" || binding.session.trim().length === 0) {
    return { ok: false, reason: "invalid_session" };
  }
  if (
    binding.streamId !== undefined &&
    binding.streamId !== null &&
    (typeof binding.streamId !== "string" || binding.streamId.trim().length === 0 || binding.streamId.length > MAX_STRING_LENGTH)
  ) {
    return { ok: false, reason: "invalid_stream_id" };
  }
  const cameraLabel =
    typeof binding.cameraLabel === "string" && binding.cameraLabel.trim().length > 0
      ? binding.cameraLabel.trim()
      : null;
  const streamId =
    typeof binding.streamId === "string" && binding.streamId.trim().length > 0
      ? binding.streamId.trim()
      : null;
  return {
    ok: true,
    binding: {
      airport: binding.airport.trim(),
      cameraId: binding.cameraId.trim(),
      principal: binding.principal.trim(),
      deviceId: binding.deviceId.toLowerCase(),
      session: binding.session.trim(),
      source: "live",
      cameraLabel,
      streamId,
    },
  };
}

function createAcousticTelemetryRegistry({ ttlMs = ACOUSTIC_TTL_MS, now = Date.now } = {}) {
  const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : ACOUSTIC_TTL_MS;
  const bindings = new Map();
  const telemetry = new Map();
  const stoppedSessions = new Set();
  const stoppedCameras = new Set();

  const inactive = () => ({ ...INACTIVE_ACOUSTIC_STATE });
  const rejected = reason => ({ accepted: false, reason, ...INACTIVE_ACOUSTIC_STATE });
  const stopKey = (cameraId, session) => `${cameraId}:${session}`;

  function rememberStopped(cameraId, session) {
    if (cameraId) {
      if (stoppedCameras.has(cameraId)) stoppedCameras.delete(cameraId);
      stoppedCameras.add(cameraId);
      while (stoppedCameras.size > MAX_STOPPED_SESSIONS) {
        stoppedCameras.delete(stoppedCameras.values().next().value);
      }
    }
    if (cameraId && session) {
      const key = stopKey(cameraId, session);
      if (stoppedSessions.has(key)) stoppedSessions.delete(key);
      stoppedSessions.add(key);
      while (stoppedSessions.size > MAX_STOPPED_SESSIONS) {
        stoppedSessions.delete(stoppedSessions.values().next().value);
      }
    }
  }

  function freshEntry(cameraId) {
    const entry = telemetry.get(cameraId);
    if (!entry) return null;
    const age = now() - entry.updatedAt;
    if (age < 0 || age >= effectiveTtlMs) {
      telemetry.delete(cameraId);
      return null;
    }
    return entry;
  }

  function bindStream(binding) {
    const check = validateStreamBinding(binding);
    if (!check.ok) return null;
    const next = check.binding;
    stoppedSessions.delete(stopKey(next.cameraId, next.session));
    stoppedCameras.delete(next.cameraId);
    const prev = bindings.get(next.cameraId);
    if (prev) {
      const sameIdentity =
        prev.session === next.session &&
        prev.principal === next.principal &&
        prev.deviceId === next.deviceId &&
        prev.airport === next.airport;
      const streamChanged = next.streamId !== prev.streamId;
      if (!sameIdentity || streamChanged) {
        telemetry.delete(next.cameraId);
      }
      if (!next.cameraLabel && sameIdentity && prev.cameraLabel) {
        next.cameraLabel = prev.cameraLabel;
      }
    }
    bindings.set(next.cameraId, { ...next });
    return { ...next };
  }

  function ingest(binding, payload) {
    if (hasForbiddenRawAudio(payload)) return rejected("raw_audio_rejected");

    let resolved = null;
    if (typeof binding === "string" && binding.trim().length > 0) {
      const id = binding.trim();
      const activeBound = bindings.get(id);
      if (activeBound) {
        resolved = activeBound;
      } else if (stoppedCameras.has(id)) {
        return rejected("stream_stopped");
      } else {
        return rejected("invalid_binding");
      }
    } else {
      const bindingCheck = validateStreamBinding(binding);
      if (!bindingCheck.ok) return rejected(bindingCheck.reason);
      resolved = bindingCheck.binding;
    }

    if (stoppedSessions.has(stopKey(resolved.cameraId, resolved.session))) {
      return rejected("stream_stopped");
    }

    let bound = bindings.get(resolved.cameraId);
    if (bound) {
      if (
        bound.airport !== resolved.airport ||
        bound.cameraId !== resolved.cameraId ||
        bound.principal !== resolved.principal ||
        bound.deviceId !== resolved.deviceId ||
        bound.session !== resolved.session
      ) {
        return rejected("binding_mismatch");
      }
      if (resolved.streamId !== null && bound.streamId !== null && resolved.streamId !== bound.streamId) {
        return rejected("stream_mismatch");
      }
    }

    const summaryCheck = validateAcousticSummary(payload);
    if (!summaryCheck.ok) return rejected(summaryCheck.reason);
    const { summary } = summaryCheck;

    if (bound && bound.streamId !== null && summary.streamId !== bound.streamId) {
      return rejected("stream_mismatch");
    }
    if (resolved.streamId !== null && summary.streamId !== resolved.streamId) {
      return rejected("stream_mismatch");
    }

    if (!bound) {
      stoppedCameras.delete(resolved.cameraId);
      bound = { ...resolved, streamId: summary.streamId };
      bindings.set(bound.cameraId, bound);
    } else {
      if (bound.streamId === null) bound.streamId = summary.streamId;
      if (resolved.cameraLabel) bound.cameraLabel = resolved.cameraLabel;
    }

    const updatedAt = now();
    const entry = {
      cameraId: bound.cameraId,
      cameraLabel: bound.cameraLabel || bound.cameraId,
      airport: bound.airport,
      streamId: summary.streamId,
      t: summary.t,
      droneProb: summary.droneProb,
      dominantHz: summary.dominantHz,
      harmonicRatio: summary.harmonicRatio,
      rmsDb: summary.rmsDb,
      humDetected: summary.humDetected,
      updatedAt,
    };
    telemetry.set(bound.cameraId, entry);

    return {
      accepted: true,
      active: true,
      droneProb: entry.droneProb,
      dominantHz: entry.dominantHz,
      humDetected: entry.humDetected,
      updatedAt: entry.updatedAt,
    };
  }

  function resolveCameraId(cameraOrId) {
    if (typeof cameraOrId === "string" && cameraOrId.trim().length > 0) return cameraOrId.trim();
    if (isPlainObject(cameraOrId) && typeof cameraOrId.cameraId === "string" && cameraOrId.cameraId.trim().length > 0) {
      return cameraOrId.cameraId.trim();
    }
    return null;
  }

  function get(cameraId, options) {
    const id = resolveCameraId(cameraId);
    if (!id) return inactive();
    const entry = freshEntry(id);
    if (!entry) return inactive();
    const airport = isPlainObject(options) ? options.airport : undefined;
    if (airport !== undefined && entry.airport !== airport) return inactive();
    return {
      active: true,
      droneProb: entry.droneProb,
      dominantHz: entry.dominantHz,
      humDetected: entry.humDetected,
      updatedAt: entry.updatedAt,
    };
  }

  function toTowerPayload(cameraId, options) {
    const id = resolveCameraId(cameraId);
    if (!id) return null;
    const entry = freshEntry(id);
    if (!entry) return null;
    const airport = isPlainObject(options) ? options.airport : undefined;
    if (airport !== undefined && entry.airport !== airport) return null;
    return {
      cameraId: entry.cameraId,
      cameraLabel: entry.cameraLabel || entry.cameraId,
      airport: entry.airport,
      source: "live",
      advisory: true,
      active: true,
      droneProb: entry.droneProb,
      dominantHz: entry.dominantHz,
      harmonicRatio: entry.harmonicRatio,
      rmsDb: entry.rmsDb,
      humDetected: entry.humDetected,
      updatedAt: entry.updatedAt,
    };
  }

  function clear(cameraOrBinding) {
    if (typeof cameraOrBinding === "string") {
      const id = cameraOrBinding.trim();
      if (!id) return inactive();
      const bound = bindings.get(id);
      telemetry.delete(id);
      bindings.delete(id);
      rememberStopped(id, bound ? bound.session : null);
      return inactive();
    }
    if (isPlainObject(cameraOrBinding)) {
      const id = typeof cameraOrBinding.cameraId === "string" ? cameraOrBinding.cameraId.trim() : "";
      if (!id) return inactive();
      const session =
        typeof cameraOrBinding.session === "string" && cameraOrBinding.session.trim().length > 0
          ? cameraOrBinding.session.trim()
          : null;
      const bound = bindings.get(id);
      if (bound && session !== null && bound.session !== session) {
        rememberStopped(null, null);
        const key = stopKey(id, session);
        if (stoppedSessions.has(key)) stoppedSessions.delete(key);
        stoppedSessions.add(key);
        while (stoppedSessions.size > MAX_STOPPED_SESSIONS) {
          stoppedSessions.delete(stoppedSessions.values().next().value);
        }
        return get(id);
      }
      telemetry.delete(id);
      bindings.delete(id);
      rememberStopped(id, session || (bound ? bound.session : null));
      return inactive();
    }
    return inactive();
  }

  function sweep() {
    for (const [cameraId, entry] of telemetry.entries()) {
      const age = now() - entry.updatedAt;
      if (age < 0 || age >= effectiveTtlMs) {
        telemetry.delete(cameraId);
      }
    }
  }

  function activeForAirport(airport) {
    sweep();
    if (typeof airport !== "string" || airport.trim().length === 0) return [];
    const target = airport.trim();
    const active = [];
    for (const cameraId of telemetry.keys()) {
      const payload = toTowerPayload(cameraId, { airport: target });
      if (payload) active.push(payload);
    }
    return active;
  }

  return {
    bindStream,
    registerStream: bindStream,
    bind: bindStream,
    add: bindStream,
    ingest,
    record: ingest,
    accept: ingest,
    update: ingest,
    get,
    read: get,
    status: get,
    snapshot: get,
    toTowerPayload,
    clear,
    stop: clear,
    disconnect: clear,
    remove: clear,
    sweep,
    activeForAirport,
  };
}

module.exports = {
  ACOUSTIC_TTL_MS,
  INACTIVE_ACOUSTIC_STATE,
  hasForbiddenRawAudio,
  validateStreamBinding,
  validateAcousticSummary,
  createAcousticTelemetryRegistry,
};
