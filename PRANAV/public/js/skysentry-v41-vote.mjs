const WINDOW_SIZE = 5;
const LABELS = ['bird', 'drone', 'other'];
const identifier = value => typeof value === 'string' && value.trim().length > 0;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const rejected = reason => ({ status: 'rejected', reason });

/**
 * Register an authoritative sampled frame with prune({cameraId, streamId, generation,
 * frameId, captureTime, liveTrackIds}). Both frameId and captureTime must advance
 * for a new frame in a phase. The roster is complete for this camera, not just
 * inferred tracks. Pruning the same frame can only narrow eligibility: it reuses
 * the handle without renewing its age or letting previously removed tracks back in.
 * Pass the returned active frame by reference to record({frame, trackId, probs});
 * keep it on the caller side of any worker boundary. Only ready results have a label.
 * Call clear(cameraId) on phase changes or feed removal, or clear() for all feeds.
 * prune() alone expires windows by local monotonic time, not the capture clock.
 */
export function createV41Votes({
  ttlMs = 3000, maxCameras = 32, maxTracks = 256, now = () => performance.now(),
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !positiveInt(maxCameras) || !positiveInt(maxTracks)) {
    throw new RangeError('Vote expiry and capacity must be positive finite limits');
  }
  if (typeof now !== 'function') throw new TypeError('Expected a monotonic vote clock');

  const phases = new Map();
  const expired = (sampledAt, at) => at - sampledAt >= ttlMs;

  function pruneTracks(tracks, live, at) {
    for (const [trackId, track] of tracks) {
      if (!live.has(trackId) || expired(track.sampledAt, at)) tracks.delete(trackId);
    }
  }

  function prune(snapshot) {
    if (snapshot === undefined) {
      const at = now();
      for (const { tracks, live } of phases.values()) pruneTracks(tracks, live, at);
      return;
    }

    const { cameraId, streamId, generation, frameId, captureTime, liveTrackIds } = snapshot ?? {};
    if (!identifier(cameraId) || !identifier(streamId) || !identifier(generation) ||
        !Number.isSafeInteger(frameId) || frameId < 0 || !Number.isFinite(captureTime)) {
      return rejected('invalid-frame');
    }
    const previous = phases.get(cameraId);
    const sameFrame = previous?.frame.frameId === frameId && previous.frame.captureTime === captureTime;
    if (previous) {
      if (previous.frame.streamId !== streamId || previous.frame.generation !== generation) {
        return rejected('wrong-phase');
      }
      if (!sameFrame && (frameId <= previous.frame.frameId || captureTime <= previous.frame.captureTime)) {
        return rejected('nonmonotonic-frame');
      }
    } else if (phases.size >= maxCameras) return rejected('camera-capacity');

    if (!Array.isArray(liveTrackIds)) return rejected('invalid-roster');
    if (liveTrackIds.length > maxTracks) return rejected('track-capacity');
    const live = new Set(liveTrackIds);
    for (const id of live) if (!positiveInt(id)) return rejected('invalid-roster');

    const sampledAt = now();
    if (sameFrame) {
      for (const id of previous.live) if (!live.has(id)) previous.live.delete(id);
      pruneTracks(previous.tracks, previous.live, sampledAt);
      return expired(previous.sampledAt, sampledAt) ? rejected('expired-frame') : previous.frame;
    }

    const tracks = previous ? previous.tracks : new Map();
    pruneTracks(tracks, live, sampledAt);
    const frame = Object.freeze({ status: 'active', cameraId, streamId, generation, frameId, captureTime });
    phases.set(cameraId, { frame, live, tracks, sampledAt });
    return frame;
  }

  function record(input) {
    const { frame, trackId, probs } = input ?? {};
    const phase = phases.get(frame?.cameraId);
    if (!phase || phase.frame !== frame) return rejected('stale-frame');
    const at = now();
    if (expired(phase.sampledAt, at)) {
      phase.tracks.clear();
      return rejected('expired-frame');
    }
    if (!phase.live.has(trackId)) return rejected('inactive-track');
    const previous = phase.tracks.get(trackId);
    if (previous?.frameId === frame.frameId) return rejected('duplicate-frame');

    const { bird, drone, other } = probs ?? {};
    const sample = { bird, drone, other };
    // The tolerance is for floating-point normalization, not label confidence.
    if (!Object.values(sample).every(p => Number.isFinite(p) && p >= 0 && p <= 1) ||
        Math.abs(bird + drone + other - 1) > 1e-6) return rejected('invalid-probabilities');

    const samples = previous && !expired(previous.sampledAt, at) ? previous.samples : [];
    samples.push(sample);
    if (samples.length > WINDOW_SIZE) samples.shift();
    phase.tracks.set(trackId, { samples, frameId: frame.frameId, sampledAt: phase.sampledAt });
    if (samples.length < WINDOW_SIZE) {
      return { status: 'collecting', count: samples.length, label: null, score: null, probs: null };
    }

    const average = {};
    let label = LABELS[0];
    for (const name of LABELS) {
      average[name] = samples.reduce((sum, p) => sum + p[name], 0) / WINDOW_SIZE;
      // Like the reference argmax, exact ties keep the first class: bird, drone, other.
      if (average[name] > average[label]) label = name;
    }
    return { status: 'ready', count: WINDOW_SIZE, label, score: average[label], probs: average };
  }

  function clear(cameraId) {
    if (cameraId === undefined) phases.clear();
    else phases.delete(cameraId);
  }

  return { record, prune, clear };
}
