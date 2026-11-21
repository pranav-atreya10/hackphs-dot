// Opt-in, privacy-preserving browser microphone rotor-hum feature extraction and summary telemetry.
// Computes spectral features strictly in memory and emits ONLY the 8-key numeric/boolean summary.
// Never records, stores, encodes, or transmits PCM samples, FFT bins, waveforms, blobs, or speech.

export const DEFAULT_TELEMETRY_INTERVAL_MS = 1000;
export const ROTOR_MIN_HZ = 80;
export const ROTOR_MAX_HZ = 600;
export const MAX_DOMINANT_HZ = 24000;
export const MIN_RMS_DB = -160;
export const MAX_RMS_DB = 6;
export const MAX_STREAM_ID_LENGTH = 128;

export const SUMMARY_KEYS = Object.freeze([
  'source',
  'streamId',
  't',
  'droneProb',
  'dominantHz',
  'harmonicRatio',
  'rmsDb',
  'humDetected',
]);

const SUMMARY_KEY_SET = new Set(SUMMARY_KEYS);
const DATA_AUDIO_URI_RE = /^\s*data:audio(?:\/|;|,|\b)/i;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isElementLike(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (typeof value.nodeType === 'number' || typeof value.setAttribute === 'function') &&
    !('streamId' in value) &&
    !('getStreamId' in value) &&
    !('isLiveStream' in value) &&
    !('intervalMs' in value),
  );
}

function isNumericSpectrumInput(input) {
  if (!input || typeof input !== 'object') return false;
  if (Array.isArray(input)) return input.length >= 8;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(input) && !(input instanceof DataView)) {
    return typeof input.length === 'number' && input.length >= 8;
  }
  return false;
}

function silentFeatures(rmsDb = MIN_RMS_DB) {
  return {
    dominantHz: 0,
    harmonicRatio: 0,
    droneProb: 0,
    rmsDb: +clamp(rmsDb, MIN_RMS_DB, MAX_RMS_DB).toFixed(1),
    humDetected: false,
  };
}

function toDbSpectrum(spectrumInput, unitHint) {
  const n = spectrumInput.length;
  const db = new Float64Array(n);

  let hasNegative = false;
  let maxLinear = 0;
  for (let i = 0; i < n; i++) {
    const v = Number(spectrumInput[i]);
    if (v < 0) {
      hasNegative = true;
      break;
    }
    if (Number.isFinite(v) && v > maxLinear) {
      maxLinear = v;
    }
  }

  const treatAsLinear =
    unitHint === 'linear' || (unitHint !== 'db' && !hasNegative);

  if (treatAsLinear) {
    if (maxLinear <= 0) {
      db.fill(MIN_RMS_DB);
      return db;
    }
    const normScale = maxLinear > 2 ? maxLinear : 1;
    for (let i = 0; i < n; i++) {
      const v = Number(spectrumInput[i]);
      if (!Number.isFinite(v) || v <= 0) {
        db[i] = MIN_RMS_DB;
      } else {
        db[i] = clamp(20 * Math.log10(v / normScale), MIN_RMS_DB, MAX_RMS_DB);
      }
    }
    return db;
  }

  for (let i = 0; i < n; i++) {
    const v = Number(spectrumInput[i]);
    db[i] = Number.isFinite(v) ? clamp(v, MIN_RMS_DB, MAX_RMS_DB) : MIN_RMS_DB;
  }
  return db;
}

function computeRmsDbFromDbBins(db) {
  let maxDb = MIN_RMS_DB;
  for (let i = 0; i < db.length; i++) {
    if (db[i] > maxDb) maxDb = db[i];
  }
  if (maxDb <= -155) return MIN_RMS_DB;

  let sumPower = 0;
  for (let i = 0; i < db.length; i++) {
    if (db[i] > MIN_RMS_DB) {
      sumPower += 10 ** (db[i] / 10);
    }
  }
  if (!Number.isFinite(sumPower) || sumPower <= 0) return MIN_RMS_DB;
  return +clamp(10 * Math.log10(sumPower), MIN_RMS_DB, MAX_RMS_DB).toFixed(1);
}

function bandPeakDb(db, centerBin, radius) {
  const n = db.length;
  const start = Math.max(1, centerBin - radius);
  const end = Math.min(n - 1, centerBin + radius);
  let peak = MIN_RMS_DB;
  for (let idx = start; idx <= end; idx++) {
    if (db[idx] > peak) peak = db[idx];
  }
  return peak;
}

export function analyzeAudioSpectrum(spectrumInput, optionsOrSampleRate = {}) {
  if (!isNumericSpectrumInput(spectrumInput)) {
    return silentFeatures(MIN_RMS_DB);
  }

  const opts =
    typeof optionsOrSampleRate === 'number'
      ? { sampleRate: optionsOrSampleRate }
      : optionsOrSampleRate && typeof optionsOrSampleRate === 'object' && !isElementLike(optionsOrSampleRate)
        ? optionsOrSampleRate
        : {};

  const n = spectrumInput.length;
  const sampleRate =
    Number.isFinite(opts.sampleRate) && opts.sampleRate > 0 ? opts.sampleRate : 48000;
  const fftSize =
    Number.isFinite(opts.fftSize) && opts.fftSize >= n * 2 ? opts.fftSize : n * 2;
  const minHz =
    Number.isFinite(opts.minHz) && opts.minHz >= 20 ? opts.minHz : ROTOR_MIN_HZ;
  const maxHz =
    Number.isFinite(opts.maxHz) && opts.maxHz > minHz ? opts.maxHz : ROTOR_MAX_HZ;

  const db = toDbSpectrum(spectrumInput, opts.unit);
  const rmsDb =
    Number.isFinite(opts.rmsDb)
      ? +clamp(opts.rmsDb, MIN_RMS_DB, MAX_RMS_DB).toFixed(1)
      : computeRmsDbFromDbBins(db);

  if (rmsDb <= -95) {
    return silentFeatures(rmsDb);
  }

  const binHz = sampleRate / fftSize;
  if (!Number.isFinite(binHz) || binHz <= 0) {
    return silentFeatures(rmsDb);
  }

  const lo = Math.max(1, Math.ceil(minHz / binHz));
  const hi = Math.min(n - 2, Math.floor(maxHz / binHz));
  if (lo > hi) {
    return silentFeatures(rmsDb);
  }

  const floorHi = Math.min(n - 1, Math.max(hi + 1, Math.floor(4000 / binHz)));
  const bandLen = floorHi - lo + 1;
  if (bandLen < 4) {
    return silentFeatures(rmsDb);
  }

  const sortedBand = new Float64Array(bandLen);
  for (let i = 0; i < bandLen; i++) {
    sortedBand[i] = db[lo + i];
  }
  sortedBand.sort();

  const floorDb = sortedBand[bandLen >> 1];
  const p90Db = sortedBand[Math.min(bandLen - 1, Math.floor(bandLen * 0.9))];
  const noiseCrestDb = Math.max(0, p90Db - floorDb);

  const minPeakProminenceDb = Math.max(12, noiseCrestDb * 2.2);
  const minHarmonicProminenceDb = Math.max(8, noiseCrestDb * 1.6);

  const harmonicWeights = [
    [2, 0.45],
    [3, 0.35],
    [4, 0.2],
  ];

  let bestScore = 0;
  let bestK = 0;
  let bestF0PromDb = 0;
  let bestHarmonicRatio = 0;
  let bestActiveHarmonics = 0;

  for (let k = lo; k <= hi; k++) {
    const val = db[k];
    if (val < db[k - 1] || val < db[k + 1]) continue;

    const f0PromDb = val - floorDb;
    if (f0PromDb < minPeakProminenceDb) continue;

    let combWeightedSum = 0;
    let availableWeight = 0;
    let activeHarmonics = 0;

    for (const [mult, weight] of harmonicWeights) {
      const hmBin = Math.round(k * mult);
      if (hmBin >= n - 1) continue;
      availableWeight += weight;
      const radius = Math.max(1, Math.min(4, Math.round(hmBin * 0.025)));
      const hmPeak = bandPeakDb(db, hmBin, radius);
      const hmProm = hmPeak - floorDb;
      if (hmProm >= minHarmonicProminenceDb) {
        activeHarmonics++;
        const strength = clamp((hmProm - minHarmonicProminenceDb + 6) / 24, 0, 1);
        combWeightedSum += weight * strength;
      }
    }

    const combRatio =
      availableWeight > 0 ? clamp(combWeightedSum / availableWeight, 0, 1) : 0;

    // Favor the true fundamental over its 2x or 3x harmonics when f0 is also prominent.
    let subharmonicPenalty = 1;
    const halfBin = Math.round(k / 2);
    if (halfBin >= lo && bandPeakDb(db, halfBin, 1) - floorDb >= minPeakProminenceDb) {
      subharmonicPenalty = 0.45;
    } else {
      const thirdBin = Math.round(k / 3);
      if (
        thirdBin >= lo &&
        bandPeakDb(db, thirdBin, 1) - floorDb >= minPeakProminenceDb &&
        bandPeakDb(db, Math.round((2 * k) / 3), 1) - floorDb >= minHarmonicProminenceDb
      ) {
        subharmonicPenalty = 0.45;
      }
    }

    const candidateScore =
      f0PromDb * (1 + 1.8 * combRatio + 0.35 * activeHarmonics) * subharmonicPenalty;

    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestK = k;
      bestF0PromDb = f0PromDb;
      bestHarmonicRatio = combRatio;
      bestActiveHarmonics = activeHarmonics;
    }
  }

  if (bestK === 0) {
    return silentFeatures(rmsDb);
  }

  let refinedBin = bestK;
  if (bestK > 0 && bestK < n - 1) {
    const left = db[bestK - 1];
    const center = db[bestK];
    const right = db[bestK + 1];
    const denom = left - 2 * center + right;
    if (denom < -1e-6) {
      const delta = (0.5 * (left - right)) / denom;
      if (Math.abs(delta) <= 0.5) {
        refinedBin = bestK + delta;
      }
    }
  }

  const dominantHz = Math.round(clamp(refinedBin * binHz, 0, MAX_DOMINANT_HZ));
  const harmonicRatio = +clamp(bestHarmonicRatio, 0, 1).toFixed(3);
  const prominenceFactor = clamp((bestF0PromDb - minPeakProminenceDb) / 26, 0, 1);

  let rawProb = 0;
  if (bestActiveHarmonics === 0) {
    rawProb = 0.22 * prominenceFactor;
  } else {
    const multiHarmonicBonus = bestActiveHarmonics >= 2 ? 0.12 : 0;
    rawProb = 0.38 * prominenceFactor + 0.55 * harmonicRatio + multiHarmonicBonus;
  }

  const droneProb = +clamp(rawProb, 0, 1).toFixed(3);
  const humDetected =
    dominantHz >= minHz &&
    dominantHz <= maxHz &&
    bestActiveHarmonics >= 1 &&
    harmonicRatio >= 0.25 &&
    droneProb >= 0.5;

  return {
    dominantHz,
    harmonicRatio,
    droneProb,
    rmsDb,
    humDetected,
  };
}

function normalizeSafeStreamId(rawStreamId) {
  if (typeof rawStreamId !== 'string') return '';
  const trimmed = rawStreamId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_STREAM_ID_LENGTH ||
    DATA_AUDIO_URI_RE.test(trimmed)
  ) {
    return '';
  }
  return trimmed;
}

function isPrecomputedFeatureObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isElementLike(value) &&
    typeof value.dominantHz === 'number' &&
    typeof value.harmonicRatio === 'number' &&
    typeof value.droneProb === 'number' &&
    typeof value.rmsDb === 'number' &&
    typeof value.humDetected === 'boolean',
  );
}

export function computeDroneHumSummary(input, rawOptions = {}) {
  const options =
    rawOptions && typeof rawOptions === 'object' && !isElementLike(rawOptions)
      ? rawOptions
      : {};

  const features = isPrecomputedFeatureObject(input)
    ? input
    : analyzeAudioSpectrum(input, options);

  const explicitStreamId = normalizeSafeStreamId(options.streamId);
  const streamId = explicitStreamId || 'stream-local';
  const rawT = Number(options.t);
  const t = Number.isFinite(rawT) && rawT >= 0 ? +rawT.toFixed(3) : 0;

  return {
    source: 'live',
    streamId,
    t,
    droneProb: +clamp(features.droneProb, 0, 1).toFixed(3) || 0,
    dominantHz: Math.round(clamp(features.dominantHz, 0, MAX_DOMINANT_HZ)) || 0,
    harmonicRatio: +clamp(features.harmonicRatio, 0, 1).toFixed(3) || 0,
    rmsDb: +clamp(features.rmsDb, MIN_RMS_DB, MAX_RMS_DB).toFixed(1) || 0,
    humDetected: Boolean(features.humDetected),
  };
}

function isCompliantSummaryPacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false;
  if (Object.getPrototypeOf(packet) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(packet).length > 0) return false;
  const keys = Object.keys(packet);
  if (keys.length !== SUMMARY_KEY_SET.size) return false;
  for (const key of keys) {
    if (!SUMMARY_KEY_SET.has(key)) return false;
  }
  return (
    packet.source === 'live' &&
    normalizeSafeStreamId(packet.streamId).length > 0 &&
    typeof packet.t === 'number' &&
    Number.isFinite(packet.t) &&
    packet.t >= 0 &&
    typeof packet.droneProb === 'number' &&
    Number.isFinite(packet.droneProb) &&
    packet.droneProb >= 0 &&
    packet.droneProb <= 1 &&
    typeof packet.dominantHz === 'number' &&
    Number.isFinite(packet.dominantHz) &&
    packet.dominantHz >= 0 &&
    packet.dominantHz <= MAX_DOMINANT_HZ &&
    typeof packet.harmonicRatio === 'number' &&
    Number.isFinite(packet.harmonicRatio) &&
    packet.harmonicRatio >= 0 &&
    packet.harmonicRatio <= 1 &&
    typeof packet.rmsDb === 'number' &&
    Number.isFinite(packet.rmsDb) &&
    packet.rmsDb >= MIN_RMS_DB &&
    packet.rmsDb <= MAX_RMS_DB &&
    typeof packet.humDetected === 'boolean'
  );
}

function collectStreamTracks(stream) {
  if (!stream || typeof stream !== 'object') return [];
  const unique = new Set();
  if (typeof stream.getAudioTracks === 'function') {
    for (const tr of stream.getAudioTracks() || []) {
      if (tr && typeof tr === 'object') unique.add(tr);
    }
  }
  if (typeof stream.getTracks === 'function') {
    for (const tr of stream.getTracks() || []) {
      if (tr && typeof tr === 'object') unique.add(tr);
    }
  }
  return [...unique];
}

function hasUsableAudioTrack(stream) {
  const tracks = collectStreamTracks(stream);
  if (tracks.length === 0) return true;
  return tracks.some(tr => tr.readyState !== 'ended' && tr.enabled !== false);
}

export function createCameraAudioTelemetry(rawOptions = {}, maybeSecondOptions = undefined) {
  const resolvedOptions = isElementLike(rawOptions)
    ? maybeSecondOptions && typeof maybeSecondOptions === 'object' && !isElementLike(maybeSecondOptions)
      ? maybeSecondOptions
      : {}
    : rawOptions && typeof rawOptions === 'object'
      ? rawOptions
      : {};

  const {
    intervalMs = DEFAULT_TELEMETRY_INTERVAL_MS,
    fftSize = 4096,
    transport = 'auto',
    endpoint = '/api/camera-audio',
    useHttp = false,
    headers = null,
    getHeaders = null,
    socket: initialSocket = null,
    getSocket = null,
    isLiveStream: isLiveStreamFn = null,
    getSource = null,
    getStreamId = null,
    getTimestamp = null,
    onSummary = null,
    audioConstraints = null,
    now = () => Date.now(),
    setIntervalFn = globalThis.setInterval,
    clearIntervalFn = globalThis.clearInterval,
  } = resolvedOptions;

  const explicitHttpConfigured = Boolean(
    useHttp ||
    transport === 'http' ||
    transport === 'both' ||
    typeof resolvedOptions.fetch === 'function' ||
    typeof resolvedOptions.endpoint === 'string' ||
    typeof resolvedOptions.httpUrl === 'string',
  );
  const targetEndpoint =
    typeof resolvedOptions.httpUrl === 'string' && resolvedOptions.httpUrl.trim()
      ? resolvedOptions.httpUrl.trim()
      : endpoint;

  const cadenceMs =
    Number.isFinite(intervalMs) && intervalMs >= 10
      ? Math.round(intervalMs)
      : DEFAULT_TELEMETRY_INTERVAL_MS;
  const readNow = typeof now === 'function' ? now : () => Date.now();

  let currentSource =
    typeof resolvedOptions.source === 'string' ? resolvedOptions.source : 'live';
  let currentStreamId =
    typeof resolvedOptions.streamId === 'string' ? resolvedOptions.streamId : '';
  let currentSocket = initialSocket;

  let enabled = false;
  let destroyed = false;
  let sessionGen = 0;
  let startedAtMs = 0;
  let timerHandle = null;
  let mediaStream = null;
  let audioContext = null;
  let sourceNode = null;
  let analyserNode = null;
  let freqScratch = null;
  let lastSummary = null;

  function resolveAudioContextCtor() {
    if (typeof resolvedOptions.AudioContext === 'function') {
      return resolvedOptions.AudioContext;
    }
    return globalThis.AudioContext || globalThis.webkitAudioContext || null;
  }

  function resolveGetUserMedia() {
    if (typeof resolvedOptions.getUserMedia === 'function') {
      return resolvedOptions.getUserMedia;
    }
    const devices = resolvedOptions.mediaDevices || globalThis.navigator?.mediaDevices;
    if (devices && typeof devices.getUserMedia === 'function') {
      return constraints => devices.getUserMedia(constraints);
    }
    return null;
  }

  function resolveFetch() {
    if (typeof resolvedOptions.fetch === 'function') {
      return resolvedOptions.fetch;
    }
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis);
    }
    return null;
  }

  function resolveSource() {
    if (typeof getSource === 'function') {
      return getSource();
    }
    return currentSource;
  }

  function resolveStreamId() {
    const raw = typeof getStreamId === 'function' ? getStreamId() : currentStreamId;
    return normalizeSafeStreamId(raw);
  }

  function isLive() {
    if (destroyed) return false;
    if (typeof isLiveStreamFn === 'function' && !isLiveStreamFn()) {
      return false;
    }
    const src = resolveSource();
    if (src !== 'live') return false;
    const sid = resolveStreamId();
    return sid.length > 0;
  }

  function resolveSocket() {
    if (typeof getSocket === 'function') return getSocket();
    return currentSocket;
  }

  function resolveTimestampSeconds() {
    if (typeof getTimestamp === 'function') {
      const val = Number(getTimestamp());
      if (Number.isFinite(val) && val >= 0) return +val.toFixed(3);
    }
    const elapsedMs = Math.max(0, readNow() - startedAtMs);
    return +(elapsedMs / 1000).toFixed(3);
  }

  function stopTimer() {
    if (timerHandle !== null) {
      const handle = timerHandle;
      timerHandle = null;
      if (typeof clearIntervalFn === 'function') {
        clearIntervalFn(handle);
      }
    }
  }

  async function teardownSession() {
    sessionGen++;
    enabled = false;
    lastSummary = null;
    stopTimer();

    if (freqScratch) {
      freqScratch.fill(0);
      freqScratch = null;
    }

    const src = sourceNode;
    const an = analyserNode;
    const stream = mediaStream;
    const ctx = audioContext;

    sourceNode = null;
    analyserNode = null;
    mediaStream = null;
    audioContext = null;

    if (src && typeof src.disconnect === 'function') {
      try {
        src.disconnect();
      } catch {
        // Ignore already-disconnected WebAudio nodes.
      }
    }
    if (an && typeof an.disconnect === 'function') {
      try {
        an.disconnect();
      } catch {
        // Ignore already-disconnected WebAudio nodes.
      }
    }

    for (const track of collectStreamTracks(stream)) {
      if (typeof track.stop === 'function') {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors during teardown.
        }
      }
    }

    if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch {
        // Ignore AudioContext close rejections.
      }
    }
  }

  function dispatchSummary(summary) {
    if (!isCompliantSummaryPacket(summary)) return false;

    const sock = resolveSocket();
    const socketReady = Boolean(
      sock && typeof sock.emit === 'function' && sock.connected !== false,
    );

    const sendViaSocket =
      (transport === 'socket' || transport === 'both' || transport === 'auto') &&
      socketReady;

    const sendViaHttp =
      transport === 'http' ||
      transport === 'both' ||
      (transport === 'auto' && explicitHttpConfigured && (useHttp || !socketReady));

    let dispatched = false;

    if (sendViaSocket) {
      sock.emit('camera:audio', summary);
      dispatched = true;
    }

    if (sendViaHttp) {
      const fetchFn = resolveFetch();
      if (fetchFn) {
        const dynamicHeaders =
          typeof getHeaders === 'function' ? getHeaders() : headers;
        const mergedHeaders = {
          'Content-Type': 'application/json',
          ...(dynamicHeaders && typeof dynamicHeaders === 'object' ? dynamicHeaders : {}),
        };
        dispatched = true;
        Promise.resolve(
          fetchFn(targetEndpoint, {
            method: 'POST',
            headers: mergedHeaders,
            body: JSON.stringify(summary),
          }),
        ).catch(() => {});
      }
    }

    if (typeof onSummary === 'function') {
      onSummary({ ...summary });
      dispatched = true;
    }

    return dispatched;
  }

  function sample() {
    if (destroyed || !enabled) return null;

    if (!isLive() || !mediaStream || !hasUsableAudioTrack(mediaStream)) {
      void teardownSession();
      return null;
    }

    if (!analyserNode || !audioContext || !freqScratch) {
      return null;
    }

    const streamId = resolveStreamId();
    if (!streamId) {
      void teardownSession();
      return null;
    }

    analyserNode.getFloatFrequencyData(freqScratch);
    const features = analyzeAudioSpectrum(freqScratch, {
      sampleRate: audioContext.sampleRate || 48000,
      fftSize: analyserNode.fftSize || freqScratch.length * 2,
    });
    // Clear transient bin buffer immediately after feature reduction.
    freqScratch.fill(0);

    if (destroyed || !enabled || !isLive()) {
      return null;
    }

    const summary = computeDroneHumSummary(features, {
      streamId,
      t: resolveTimestampSeconds(),
    });

    if (!isCompliantSummaryPacket(summary)) {
      return null;
    }

    lastSummary = { ...summary };
    dispatchSummary(summary);
    return { ...summary };
  }

  async function enable() {
    if (destroyed) {
      return { ok: false, enabled: false, reason: 'destroyed' };
    }
    if (!isLive()) {
      await teardownSession();
      return { ok: false, enabled: false, reason: 'non_live_stream' };
    }
    if (enabled && audioContext && analyserNode && mediaStream) {
      return { ok: true, enabled: true };
    }

    const getUserMedia = resolveGetUserMedia();
    if (!getUserMedia) {
      return { ok: false, enabled: false, reason: 'media_devices_unavailable' };
    }
    const AudioContextCtor = resolveAudioContextCtor();
    if (!AudioContextCtor) {
      return { ok: false, enabled: false, reason: 'audio_context_unavailable' };
    }

    const gen = ++sessionGen;
    const constraints =
      audioConstraints && typeof audioConstraints === 'object'
        ? audioConstraints
        : {
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            video: false,
          };

    let stream = null;
    let ctx = null;

    try {
      stream = await getUserMedia(constraints);
      if (gen !== sessionGen || destroyed || !isLive()) {
        for (const tr of collectStreamTracks(stream)) {
          if (typeof tr.stop === 'function') tr.stop();
        }
        return { ok: false, enabled: false, reason: 'cancelled' };
      }

      ctx = new AudioContextCtor();
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await Promise.resolve(ctx.resume()).catch(() => {});
      }
      if (gen !== sessionGen || destroyed || !isLive()) {
        for (const tr of collectStreamTracks(stream)) {
          if (typeof tr.stop === 'function') tr.stop();
        }
        if (ctx.state !== 'closed' && typeof ctx.close === 'function') {
          await Promise.resolve(ctx.close()).catch(() => {});
        }
        return { ok: false, enabled: false, reason: 'cancelled' };
      }

      const srcNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      const targetFftSize =
        Number.isFinite(fftSize) && fftSize >= 256 ? fftSize : 4096;
      try {
        analyser.fftSize = targetFftSize;
      } catch {
        // Keep browser/mock default fftSize if read-only.
      }
      try {
        analyser.smoothingTimeConstant = 0.25;
      } catch {
        // Optional property on mock AnalyserNode.
      }

      srcNode.connect(analyser);

      const binCount =
        Number.isFinite(analyser.frequencyBinCount) && analyser.frequencyBinCount >= 8
          ? analyser.frequencyBinCount
          : Math.max(128, (analyser.fftSize || targetFftSize) >> 1);

      mediaStream = stream;
      audioContext = ctx;
      sourceNode = srcNode;
      analyserNode = analyser;
      freqScratch = new Float32Array(binCount);
      startedAtMs = readNow();
      enabled = true;

      stopTimer();
      if (typeof setIntervalFn === 'function') {
        const handle = setIntervalFn(() => {
          sample();
        }, cadenceMs);
        if (handle && typeof handle === 'object' && typeof handle.unref === 'function') {
          handle.unref();
        }
        timerHandle = handle;
      }

      return { ok: true, enabled: true };
    } catch (err) {
      for (const tr of collectStreamTracks(stream)) {
        if (typeof tr.stop === 'function') {
          try {
            tr.stop();
          } catch {}
        }
      }
      if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
        await Promise.resolve(ctx.close()).catch(() => {});
      }
      if (gen === sessionGen) {
        enabled = false;
      }
      return {
        ok: false,
        enabled: false,
        reason: err && typeof err.name === 'string' ? err.name : 'mic_error',
      };
    }
  }

  async function disable() {
    await teardownSession();
    return { ok: true, enabled: false };
  }

  async function toggle(force) {
    const wantEnabled = typeof force === 'boolean' ? force : !enabled;
    return wantEnabled ? enable() : disable();
  }

  function setStream(next = {}) {
    if (next && typeof next === 'object') {
      if ('source' in next) {
        currentSource = typeof next.source === 'string' ? next.source : '';
      }
      if ('streamId' in next) {
        currentStreamId = typeof next.streamId === 'string' ? next.streamId : '';
      }
      if ('socket' in next) {
        currentSocket = next.socket ?? null;
      }
    }
    if (enabled && !isLive()) {
      void teardownSession();
    }
    return { live: isLive(), enabled };
  }

  function setSource(nextSource) {
    return setStream({ source: nextSource });
  }

  function setStreamId(nextStreamId) {
    return setStream({ streamId: nextStreamId });
  }

  function setSocket(nextSocket) {
    currentSocket = nextSocket ?? null;
    return currentSocket;
  }

  async function destroy() {
    destroyed = true;
    await teardownSession();
  }

  return {
    get enabled() {
      return enabled;
    },
    isEnabled: () => enabled,
    isLive,
    enable,
    disable,
    stop: disable,
    toggle,
    sample,
    tick: sample,
    setStream,
    setSource,
    setStreamId,
    setSocket,
    getLastSummary: () => (lastSummary ? { ...lastSummary } : null),
    clear: disable,
    close: disable,
    detach: () => {
      currentSocket = null;
      return disable();
    },
    destroy,
    dispose: destroy,
  };
}
