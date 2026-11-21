'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  ACOUSTIC_TTL_MS,
  INACTIVE_ACOUSTIC_STATE,
  hasForbiddenRawAudio,
  validateStreamBinding,
  validateAcousticSummary,
  createAcousticTelemetryRegistry,
} = require('../camera-audio');

const TELEMETRY_MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'camera-audio-telemetry.mjs'),
).href;
const PILL_MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'public', 'js', 'tower-acoustic-pill.mjs'),
).href;

const VALID_DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_DEVICE_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function buildSyntheticSpectrumDb({
  sampleRate = 48000,
  fftSize = 4096,
  floorDb = -90,
  tones = [],
  noiseAmplitudeDb = 0,
  seed = 42,
} = {}) {
  const binCount = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const bins = new Float32Array(binCount);

  // Deterministic PRNG so broadband noise tests are 100% reproducible.
  let state = seed >>> 0;
  const nextRand = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let i = 0; i < binCount; i++) {
    const jitter = noiseAmplitudeDb > 0 ? (nextRand() * 2 - 1) * noiseAmplitudeDb : 0;
    bins[i] = floorDb + jitter;
  }

  for (const { hz, db } of tones) {
    const center = hz / binHz;
    const k = Math.round(center);
    if (k >= 1 && k < binCount - 1) {
      // Realistic Hann-windowed spectral peak across center and immediate side-lobes.
      bins[k] = Math.max(bins[k], db);
      bins[k - 1] = Math.max(bins[k - 1], db - 6);
      bins[k + 1] = Math.max(bins[k + 1], db - 6);
    }
  }

  return bins;
}

function createMockWebAudioHarness(getSpectrumBins, { sampleRate = 48000, fftSize = 4096 } = {}) {
  let getUserMediaCalls = 0;
  let lastConstraints = null;
  let trackStopCalls = 0;
  let contextCreatedCount = 0;
  let contextCloseCalls = 0;
  let sourceDisconnectCalls = 0;
  let analyserDisconnectCalls = 0;

  const track = {
    kind: 'audio',
    enabled: true,
    readyState: 'live',
    stop() {
      trackStopCalls++;
      this.readyState = 'ended';
    },
  };

  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };

  const getUserMedia = async constraints => {
    getUserMediaCalls++;
    lastConstraints = constraints;
    track.readyState = 'live';
    track.enabled = true;
    return stream;
  };

  class MockAudioContext {
    constructor() {
      contextCreatedCount++;
      this.sampleRate = sampleRate;
      this.state = 'running';
    }

    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {
          sourceDisconnectCalls++;
        },
      };
    }

    createAnalyser() {
      return {
        fftSize,
        smoothingTimeConstant: 0.25,
        get frequencyBinCount() {
          return this.fftSize >> 1;
        },
        getFloatFrequencyData(target) {
          const src = getSpectrumBins();
          const len = Math.min(target.length, src.length);
          for (let i = 0; i < len; i++) target[i] = src[i];
        },
        disconnect() {
          analyserDisconnectCalls++;
        },
      };
    }

    async close() {
      contextCloseCalls++;
      this.state = 'closed';
    }
  }

  return {
    track,
    stream,
    getUserMedia,
    MockAudioContext,
    stats: () => ({
      getUserMediaCalls,
      lastConstraints,
      trackStopCalls,
      contextCreatedCount,
      contextCloseCalls,
      sourceDisconnectCalls,
      analyserDisconnectCalls,
    }),
  };
}

/* ========================================================================== *
 *  1. Server Privacy Guard & Registry (`PRANAV/camera-audio.js`)             *
 * ========================================================================== */

describe('Stream 7 server guard & registry (PRANAV/camera-audio.js)', () => {
  test('hasForbiddenRawAudio rejects binary buffers, PCM/FFT/speech keys, arrays, data:audio URIs, and oversized strings', () => {
    assert.equal(hasForbiddenRawAudio(new Float32Array([0.1, -0.2, 0.3])), true);
    assert.equal(hasForbiddenRawAudio(Buffer.from([1, 2, 3, 4])), true);
    assert.equal(hasForbiddenRawAudio(new Uint8Array(16).buffer), true);
    assert.equal(hasForbiddenRawAudio([0.1, 0.2, 0.3]), true);

    for (const forbiddenKey of [
      'pcm',
      'rawPcm',
      'samples',
      'audioSamples',
      'fft',
      'fftBins',
      'spectrum',
      'waveform',
      'audioBuffer',
      'transcript',
      'speechText',
      'voiceClip',
      'recordingBlob',
      'opusChunk',
    ]) {
      assert.equal(
        hasForbiddenRawAudio({ [forbiddenKey]: 1 }),
        true,
        `expected forbidden key "${forbiddenKey}" to be rejected`,
      );
    }

    assert.equal(
      hasForbiddenRawAudio({ streamId: 'data:audio/webm;codecs=opus;base64,AAAA' }),
      true,
    );
    assert.equal(
      hasForbiddenRawAudio({ streamId: 'x'.repeat(129) }),
      true,
    );
    assert.equal(
      hasForbiddenRawAudio({ nested: { bytes: Buffer.from('abcd').toJSON() } }),
      true,
    );

    assert.equal(
      hasForbiddenRawAudio({
        source: 'live',
        streamId: 'stream-live-01',
        t: 4.5,
        droneProb: 0.84,
        dominantHz: 180,
        harmonicRatio: 0.8,
        rmsDb: -21.4,
        humDetected: true,
      }),
      false,
    );
  });

  test('validateAcousticSummary enforces exact 8-key numeric/boolean schema and live provenance', async () => {
    const { computeDroneHumSummary } = await import(TELEMETRY_MODULE_URL);
    const rotorBins = buildSyntheticSpectrumDb({
      tones: [
        { hz: 180, db: -18 },
        { hz: 360, db: -24 },
        { hz: 540, db: -30 },
      ],
    });

    const summary = computeDroneHumSummary(rotorBins, {
      streamId: 'live-cam-stream-7',
      t: 12.345,
      sampleRate: 48000,
    });

    const okResult = validateAcousticSummary(summary);
    assert.equal(okResult.ok, true);
    assert.deepEqual(Object.keys(okResult.summary).sort(), [
      'dominantHz',
      'droneProb',
      'harmonicRatio',
      'humDetected',
      'rmsDb',
      'source',
      'streamId',
      't',
    ]);

    assert.deepEqual(validateAcousticSummary({ ...summary, source: 'demo' }), {
      ok: false,
      reason: 'non_live_source',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, extraField: 1 }), {
      ok: false,
      reason: 'unexpected_field',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, pcm: new Float32Array(8) }), {
      ok: false,
      reason: 'raw_audio_rejected',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, droneProb: 1.2 }), {
      ok: false,
      reason: 'invalid_drone_prob',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, dominantHz: 30000 }), {
      ok: false,
      reason: 'invalid_dominant_hz',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, harmonicRatio: -0.1 }), {
      ok: false,
      reason: 'invalid_harmonic_ratio',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, rmsDb: 12 }), {
      ok: false,
      reason: 'invalid_rms_db',
    });
    assert.deepEqual(validateAcousticSummary({ ...summary, humDetected: 'yes' }), {
      ok: false,
      reason: 'invalid_hum_detected',
    });
  });

  test('createAcousticTelemetryRegistry enforces binding identity, 3000ms TTL, clear() stop tombstone, and cross-airport isolation', () => {
    let clock = 50_000;
    const registry = createAcousticTelemetryRegistry({
      ttlMs: ACOUSTIC_TTL_MS,
      now: () => clock,
    });

    const jfkBinding = {
      airport: 'KJFK',
      cameraId: 'cam-jfk-east',
      cameraLabel: 'Runway 04R East',
      principal: 'operator@jfk.example',
      deviceId: VALID_DEVICE_ID,
      session: 'sess-jfk-1',
      source: 'live',
      streamId: 'stream-jfk-1',
    };

    const lgaBinding = {
      airport: 'KLGA',
      cameraId: 'cam-lga-north',
      cameraLabel: 'Runway 13 North',
      principal: 'operator@lga.example',
      deviceId: SECOND_DEVICE_ID,
      session: 'sess-lga-1',
      source: 'live',
      streamId: 'stream-lga-1',
    };

    assert.ok(validateStreamBinding(jfkBinding).ok);
    registry.bindStream(jfkBinding);
    registry.bindStream(lgaBinding);

    const jfkPacket = {
      source: 'live',
      streamId: 'stream-jfk-1',
      t: 2.0,
      droneProb: 0.84,
      dominantHz: 180,
      harmonicRatio: 0.8,
      rmsDb: -19.5,
      humDetected: true,
    };

    const lgaPacket = {
      source: 'live',
      streamId: 'stream-lga-1',
      t: 2.0,
      droneProb: 0.72,
      dominantHz: 220,
      harmonicRatio: 0.75,
      rmsDb: -22.0,
      humDetected: true,
    };

    assert.equal(registry.ingest(jfkBinding, jfkPacket).accepted, true);
    assert.equal(registry.ingest(lgaBinding, lgaPacket).accepted, true);

    // Mismatched streamId or hijacked principal/session is rejected without clobbering active state.
    assert.equal(
      registry.ingest(jfkBinding, { ...jfkPacket, streamId: 'wrong-stream' }).reason,
      'stream_mismatch',
    );
    assert.equal(
      registry.ingest({ ...jfkBinding, session: 'hijack-session' }, jfkPacket).reason,
      'binding_mismatch',
    );

    // Cross-airport isolation via get(), toTowerPayload(), and activeForAirport().
    const jfkActive = registry.activeForAirport('KJFK');
    assert.equal(jfkActive.length, 1);
    assert.equal(jfkActive[0].cameraId, 'cam-jfk-east');
    assert.equal(jfkActive[0].advisory, true);
    assert.equal(registry.toTowerPayload('cam-jfk-east', { airport: 'KLGA' }), null);
    assert.deepEqual(registry.get('cam-jfk-east', { airport: 'KLGA' }), INACTIVE_ACOUSTIC_STATE);

    // 3000ms TTL expiry resets stale entries automatically.
    clock += 2999;
    assert.equal(registry.get('cam-lga-north', { airport: 'KLGA' }).active, true);
    clock += 1;
    assert.deepEqual(registry.get('cam-lga-north', { airport: 'KLGA' }), INACTIVE_ACOUSTIC_STATE);
    assert.deepEqual(registry.activeForAirport('KLGA'), []);

    // Refresh JFK, then clear() and verify stop tombstone blocks late packets from the stopped session.
    registry.ingest(jfkBinding, { ...jfkPacket, t: 5.0 });
    assert.equal(registry.get('cam-jfk-east').active, true);

    registry.clear({ cameraId: 'cam-jfk-east', session: 'sess-jfk-1' });
    assert.deepEqual(registry.get('cam-jfk-east'), INACTIVE_ACOUSTIC_STATE);

    const lateReplay = registry.ingest(jfkBinding, { ...jfkPacket, t: 5.2 });
    assert.equal(lateReplay.accepted, false);
    assert.equal(lateReplay.reason, 'stream_stopped');
    assert.equal(registry.ingest('cam-jfk-east', jfkPacket).reason, 'stream_stopped');

    // A fresh bindStream with a new session re-enables ingestion cleanly.
    const freshJfkBinding = { ...jfkBinding, session: 'sess-jfk-2', streamId: 'stream-jfk-2' };
    registry.bindStream(freshJfkBinding);
    assert.equal(
      registry.ingest(freshJfkBinding, { ...jfkPacket, streamId: 'stream-jfk-2', t: 0.5 }).accepted,
      true,
    );
  });
});

/* ========================================================================== *
 *  2. Browser Rotor-Hum Telemetry (`PRANAV/public/js/camera-audio-telemetry`) *
 * ========================================================================== */

describe('Stream 7 browser feature extraction & opt-in controller (camera-audio-telemetry.mjs)', () => {
  test('synthetic 180 Hz + 360 Hz + 540 Hz rotor harmonic spectrum yields high harmonicRatio, droneProb >= 0.6, and humDetected: true', async () => {
    const { analyzeAudioSpectrum, computeDroneHumSummary } = await import(TELEMETRY_MODULE_URL);

    const rotorSpectrum = buildSyntheticSpectrumDb({
      sampleRate: 48000,
      fftSize: 4096,
      floorDb: -90,
      tones: [
        { hz: 180, db: -18 },
        { hz: 360, db: -24 },
        { hz: 540, db: -30 },
      ],
    });

    const features = analyzeAudioSpectrum(rotorSpectrum, { sampleRate: 48000, fftSize: 4096 });
    assert.ok(
      Math.abs(features.dominantHz - 180) <= 6,
      `expected dominantHz near 180 Hz, got ${features.dominantHz}`,
    );
    assert.ok(
      features.harmonicRatio >= 0.6,
      `expected high harmonicRatio >= 0.6, got ${features.harmonicRatio}`,
    );
    assert.ok(
      features.droneProb >= 0.6,
      `expected droneProb >= 0.6, got ${features.droneProb}`,
    );
    assert.equal(features.humDetected, true);
    assert.ok(features.rmsDb >= -160 && features.rmsDb <= 6);

    const summary = computeDroneHumSummary(rotorSpectrum, {
      streamId: 'stream-rotor-180',
      t: 3.25,
      sampleRate: 48000,
    });
    const check = validateAcousticSummary(summary);
    assert.equal(check.ok, true);
    assert.equal(check.summary.humDetected, true);
    assert.ok(check.summary.droneProb >= 0.6);
  });

  test('broadband white noise, pure silence, and unharmonic single sine tone yield humDetected: false', async () => {
    const { analyzeAudioSpectrum } = await import(TELEMETRY_MODULE_URL);

    const silenceDb = new Float32Array(2048).fill(-160);
    const silenceZero = new Float32Array(2048);
    const whiteNoiseDb = buildSyntheticSpectrumDb({
      floorDb: -60,
      noiseAmplitudeDb: 4.5,
      seed: 1337,
    });
    const singleBeepDb = buildSyntheticSpectrumDb({
      floorDb: -90,
      tones: [{ hz: 240, db: -20 }],
    });

    for (const [label, bins] of [
      ['silence (-160 dB)', silenceDb],
      ['silence (linear 0)', silenceZero],
      ['broadband white noise', whiteNoiseDb],
      ['single unharmonic tone', singleBeepDb],
    ]) {
      const res = analyzeAudioSpectrum(bins, 48000);
      assert.equal(res.humDetected, false, `${label} must not trigger humDetected`);
      assert.ok(res.droneProb < 0.5, `${label} expected droneProb < 0.5, got ${res.droneProb}`);
      assert.ok(res.rmsDb >= -160 && res.rmsDb <= 6);
    }
  });

  test('starts disabled by default (zero getUserMedia calls until enable()), round-trips via validateAcousticSummary, and tears down cleanly', async () => {
    const { createCameraAudioTelemetry } = await import(TELEMETRY_MODULE_URL);

    let activeBins = buildSyntheticSpectrumDb({
      tones: [
        { hz: 180, db: -16 },
        { hz: 360, db: -22 },
        { hz: 540, db: -28 },
      ],
    });

    const harness = createMockWebAudioHarness(() => activeBins);
    const emittedSocket = [];
    const emittedHttp = [];
    let manualTick = null;
    let clearedTimers = 0;
    let nowMs = 1_000;

    const socket = {
      connected: true,
      emit(event, payload) {
        emittedSocket.push([event, payload]);
      },
    };

    const mockFetch = async (url, init) => {
      emittedHttp.push({ url, method: init.method, body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    };

    const telemetry = createCameraAudioTelemetry({
      source: 'live',
      streamId: 'live-stream-alpha',
      socket,
      fetch: mockFetch,
      transport: 'both',
      getUserMedia: harness.getUserMedia,
      AudioContext: harness.MockAudioContext,
      now: () => nowMs,
      setIntervalFn: fn => {
        manualTick = fn;
        return 77;
      },
      clearIntervalFn: id => {
        if (id === 77) clearedTimers++;
      },
    });

    // Default off: zero mic access, zero AudioContext creation, zero packets.
    assert.equal(telemetry.enabled, false);
    assert.equal(telemetry.isEnabled(), false);
    assert.equal(harness.stats().getUserMediaCalls, 0);
    assert.equal(harness.stats().contextCreatedCount, 0);
    assert.equal(telemetry.sample(), null);
    assert.deepEqual(emittedSocket, []);
    assert.deepEqual(emittedHttp, []);

    // Opt-in enable() acquires audio-only stream and sets up WebAudio AnalyserNode.
    const enabledRes = await telemetry.enable();
    assert.deepEqual(enabledRes, { ok: true, enabled: true });
    assert.equal(telemetry.enabled, true);
    assert.equal(harness.stats().getUserMediaCalls, 1);
    assert.equal(Boolean(harness.stats().lastConstraints.audio), true);
    assert.equal(harness.stats().lastConstraints.video, false);

    nowMs += 1000;
    assert.equal(typeof manualTick, 'function');
    manualTick();

    assert.equal(emittedSocket.length, 1);
    assert.equal(emittedSocket[0][0], 'camera:audio');
    const packet = emittedSocket[0][1];

    // Strict schema & privacy verification via camera-audio.js.
    assert.equal(hasForbiddenRawAudio(packet), false);
    const validation = validateAcousticSummary(packet);
    assert.equal(validation.ok, true);
    assert.equal(packet.source, 'live');
    assert.equal(packet.streamId, 'live-stream-alpha');
    assert.equal(packet.t, 1);
    assert.equal(packet.humDetected, true);
    assert.ok(packet.droneProb >= 0.6);
    assert.ok(Math.abs(packet.dominantHz - 180) <= 6);

    assert.equal(emittedHttp.length, 1);
    assert.equal(emittedHttp[0].url, '/api/camera-audio');
    assert.equal(emittedHttp[0].method, 'POST');
    assert.deepEqual(emittedHttp[0].body, packet);

    // Clean teardown on stop() & destroy() releases MediaStreamTrack and closes AudioContext.
    await telemetry.stop();
    assert.equal(telemetry.enabled, false);
    assert.equal(telemetry.getLastSummary(), null);
    assert.equal(harness.stats().trackStopCalls, 1);
    assert.equal(harness.stats().contextCloseCalls, 1);
    assert.equal(harness.stats().sourceDisconnectCalls, 1);
    assert.equal(harness.stats().analyserDisconnectCalls, 1);
    assert.equal(clearedTimers, 1);

    await telemetry.destroy();
    const afterDestroy = await telemetry.enable();
    assert.equal(afterDestroy.ok, false);
    assert.equal(afterDestroy.reason, 'destroyed');
    assert.equal(harness.stats().getUserMediaCalls, 1);
  });

  test('suppresses getUserMedia and immediately stops emission when stream is demo, clip, synthetic, or missing streamId', async () => {
    const { createCameraAudioTelemetry } = await import(TELEMETRY_MODULE_URL);
    const rotorBins = buildSyntheticSpectrumDb({
      tones: [
        { hz: 180, db: -18 },
        { hz: 360, db: -24 },
        { hz: 540, db: -30 },
      ],
    });
    const harness = createMockWebAudioHarness(() => rotorBins);
    const packets = [];
    const socket = {
      connected: true,
      emit(ev, data) {
        packets.push([ev, data]);
      },
    };

    const telemetry = createCameraAudioTelemetry({
      source: 'demo',
      streamId: 'demo-clip-1',
      socket,
      getUserMedia: harness.getUserMedia,
      AudioContext: harness.MockAudioContext,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });

    // Refuses to open mic in demo mode.
    const deniedDemo = await telemetry.enable();
    assert.equal(deniedDemo.ok, false);
    assert.equal(deniedDemo.reason, 'non_live_stream');
    assert.equal(harness.stats().getUserMediaCalls, 0);
    assert.deepEqual(packets, []);

    // Switch to live stream -> enables and emits.
    telemetry.setStream({ source: 'live', streamId: 'live-webcam-99' });
    assert.equal((await telemetry.enable()).ok, true);
    assert.ok(telemetry.sample());
    assert.equal(packets.length, 1);

    // Switching to synthetic/clip/demo immediately disables, tears down mic, and emits nothing further.
    telemetry.setSource('synthetic');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(telemetry.enabled, false);
    assert.equal(harness.stats().trackStopCalls, 1);
    assert.equal(harness.stats().contextCloseCalls, 1);
    assert.equal(telemetry.sample(), null);
    assert.equal(packets.length, 1);
  });

  test('releases late getUserMedia streams when stopped mid-permission and supports globalThis.webkitAudioContext fallback', async () => {
    const { createCameraAudioTelemetry } = await import(TELEMETRY_MODULE_URL);

    let resolveMic;
    const pendingMic = new Promise(resolve => {
      resolveMic = resolve;
    });
    let lateTrackStops = 0;
    const lateStream = {
      getTracks: () => [
        {
          stop() {
            lateTrackStops++;
          },
        },
      ],
    };

    const raceController = createCameraAudioTelemetry({
      source: 'live',
      streamId: 'live-race-1',
      getUserMedia: () => pendingMic,
      AudioContext: class {
        close() {}
      },
    });

    const enabling = raceController.enable();
    await raceController.stop();
    resolveMic(lateStream);
    const raceRes = await enabling;
    assert.equal(raceRes.ok, false);
    assert.equal(raceRes.enabled, false);
    assert.equal(lateTrackStops, 1);

    // Verify globalThis.webkitAudioContext + globalThis.navigator.mediaDevices.getUserMedia lookup.
    const rotorBins = buildSyntheticSpectrumDb({
      tones: [
        { hz: 180, db: -18 },
        { hz: 360, db: -24 },
        { hz: 540, db: -30 },
      ],
    });
    const harness = createMockWebAudioHarness(() => rotorBins);
    const prevAudioCtx = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const prevWebkitCtx = Object.getOwnPropertyDescriptor(globalThis, 'webkitAudioContext');
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    try {
      delete globalThis.AudioContext;
      Object.defineProperty(globalThis, 'webkitAudioContext', {
        configurable: true,
        writable: true,
        value: harness.MockAudioContext,
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: { mediaDevices: { getUserMedia: harness.getUserMedia } },
      });

      const emitted = [];
      const fallbackTelemetry = createCameraAudioTelemetry({
        source: 'live',
        streamId: 'webkit-live-stream',
        onSummary: s => emitted.push(s),
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });

      assert.equal((await fallbackTelemetry.enable()).ok, true);
      const pkt = fallbackTelemetry.sample();
      assert.ok(pkt);
      assert.equal(validateAcousticSummary(pkt).ok, true);
      assert.equal(emitted.length, 1);
      await fallbackTelemetry.destroy();
      assert.equal(harness.stats().trackStopCalls, 1);
      assert.equal(harness.stats().contextCloseCalls, 1);
    } finally {
      if (prevAudioCtx) Object.defineProperty(globalThis, 'AudioContext', prevAudioCtx);
      else delete globalThis.AudioContext;
      if (prevWebkitCtx) Object.defineProperty(globalThis, 'webkitAudioContext', prevWebkitCtx);
      else delete globalThis.webkitAudioContext;
      if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
      else delete globalThis.navigator;
    }
  });
});

/* ========================================================================== *
 *  3. Tower Advisory Pill & Full Stream 7 Pipeline (`tower-acoustic-pill`)   *
 * ========================================================================== */

describe('Stream 7 tower advisory HUD pill & end-to-end integration (tower-acoustic-pill.mjs)', () => {
  test('transitions across inactive -> monitoring -> advisory states, auto-resets after 3s TTL, and rejects demo/raw-audio/other-airport packets', async () => {
    const {
      ACOUSTIC_INACTIVE_TEXT,
      ACOUSTIC_MONITORING_TEXT,
      createTowerAcousticHud,
    } = await import(PILL_MODULE_URL);

    let nowMs = 20_000;
    const scheduled = new Map();
    let timerId = 1;

    const hud = createTowerAcousticHud({
      airport: 'KJFK',
      ttlMs: 3000,
      now: () => nowMs,
      setTimer: (fn, delay) => {
        const id = timerId++;
        scheduled.set(id, { fn, runAt: nowMs + delay });
        return id;
      },
      clearTimer: id => {
        scheduled.delete(id);
      },
    });

    const sidebarPill = hud.mountSidebar();
    const camPill = hud.mountCamera('cam-1');

    // Initial state: Video only · mic off
    assert.equal(sidebarPill.textContent, 'Video only · mic off');
    assert.equal(sidebarPill.textContent, ACOUSTIC_INACTIVE_TEXT);
    assert.equal(sidebarPill.dataset.acousticState, 'inactive');
    assert.equal(camPill.textContent, 'Video only · mic off');
    assert.equal(camPill.dataset.acousticState, 'inactive');

    // Monitoring state (mic on, no drone hum detected)
    hud.update({
      cameraId: 'cam-1',
      airport: 'KJFK',
      source: 'live',
      active: true,
      droneProb: 0.08,
      dominantHz: 0,
      humDetected: false,
      updatedAt: nowMs,
    });
    assert.equal(camPill.textContent, 'Acoustic monitor · mic on (advisory)');
    assert.equal(camPill.textContent, ACOUSTIC_MONITORING_TEXT);
    assert.equal(camPill.dataset.acousticState, 'monitoring');
    assert.equal(sidebarPill.textContent, 'Acoustic monitor · mic on (advisory)');

    // Advisory state (180 Hz, 84%)
    nowMs += 500;
    hud.update({
      cameraId: 'cam-1',
      airport: 'KJFK',
      source: 'live',
      active: true,
      droneProb: 0.84,
      dominantHz: 180,
      humDetected: true,
      updatedAt: nowMs,
    });
    assert.equal(camPill.textContent, 'Acoustic monitor · 180 Hz (84%)');
    assert.equal(camPill.dataset.acousticState, 'advisory');
    assert.equal(sidebarPill.textContent, 'Acoustic monitor · 180 Hz (84%)');
    assert.equal(sidebarPill.dataset.acousticState, 'advisory');

    // Rejects raw audio fields, demo payloads, and cross-airport packets without altering KJFK state.
    assert.equal(
      hud.update({
        cameraId: 'cam-1',
        airport: 'KJFK',
        source: 'live',
        pcm: new Float32Array([0.2, -0.2]),
        droneProb: 0.99,
        dominantHz: 300,
        humDetected: true,
      }),
      null,
    );
    assert.equal(
      hud.update({
        cameraId: 'cam-1',
        airport: 'KJFK',
        source: 'demo',
        demo: true,
        droneProb: 0.99,
        dominantHz: 300,
        humDetected: true,
      }),
      null,
    );
    assert.equal(
      hud.update({
        cameraId: 'cam-2',
        airport: 'KEWR',
        source: 'live',
        droneProb: 0.95,
        dominantHz: 250,
        humDetected: true,
        updatedAt: nowMs,
      }),
      null,
    );
    assert.equal(sidebarPill.textContent, 'Acoustic monitor · 180 Hz (84%)');

    // 3s TTL auto-reset fires and returns both camera and sidebar pills to "Video only · mic off".
    nowMs += 3000;
    for (const [id, entry] of [...scheduled.entries()]) {
      if (entry.runAt <= nowMs) {
        scheduled.delete(id);
        entry.fn();
      }
    }
    assert.equal(camPill.textContent, 'Video only · mic off');
    assert.equal(camPill.dataset.acousticState, 'inactive');
    assert.equal(sidebarPill.textContent, 'Video only · mic off');
    assert.equal(sidebarPill.dataset.acousticState, 'inactive');

    hud.destroy();
  });

  test('end-to-end Stream 7 pipeline: browser telemetry -> server registry -> tower HUD pill', async () => {
    const { createCameraAudioTelemetry } = await import(TELEMETRY_MODULE_URL);
    const { createTowerAcousticHud } = await import(PILL_MODULE_URL);

    let clock = 100_000;
    const registry = createAcousticTelemetryRegistry({ now: () => clock });
    const binding = {
      airport: 'KJFK',
      cameraId: 'cam-runway-22l',
      cameraLabel: 'Runway 22L Threshold',
      principal: 'cam-key@kjfk',
      deviceId: VALID_DEVICE_ID,
      session: 'sock-live-22l',
      source: 'live',
      streamId: 'stream-22l',
    };
    registry.bindStream(binding);

    const hud = createTowerAcousticHud({
      airport: 'KJFK',
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const sidebar = hud.mountSidebar();
    const tilePill = hud.mountCamera('cam-runway-22l');

    const rotorBins = buildSyntheticSpectrumDb({
      tones: [
        { hz: 180, db: -19 },
        { hz: 360, db: -25 },
        { hz: 540, db: -31 },
      ],
    });
    const harness = createMockWebAudioHarness(() => rotorBins);

    const cameraSocket = {
      connected: true,
      emit(event, summary) {
        assert.equal(event, 'camera:audio');
        const res = registry.ingest(binding, summary);
        assert.equal(res.accepted, true);
        const towerPayload = registry.toTowerPayload('cam-runway-22l', { airport: 'KJFK' });
        assert.ok(towerPayload);
        hud.onBotAudio(towerPayload);
      },
    };

    const telemetry = createCameraAudioTelemetry({
      source: 'live',
      streamId: 'stream-22l',
      socket: cameraSocket,
      getUserMedia: harness.getUserMedia,
      AudioContext: harness.MockAudioContext,
      now: () => clock,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });

    await telemetry.enable();
    clock += 1000;
    const sent = telemetry.sample();
    assert.ok(sent);

    assert.equal(tilePill.dataset.acousticState, 'advisory');
    assert.match(tilePill.textContent, /^Acoustic monitor · \d+ Hz \(\d+%\)$/);
    assert.equal(sidebar.textContent, tilePill.textContent);

    // Camera stops -> registry clears -> tower HUD resets to inactive.
    await telemetry.stop();
    const clearedState = registry.clear(binding);
    hud.onBotAudio({ cameraId: 'cam-runway-22l', airport: 'KJFK', source: 'live', ...clearedState });
    assert.equal(tilePill.textContent, 'Video only · mic off');
    assert.equal(sidebar.textContent, 'Video only · mic off');

    hud.destroy();
  });
});
