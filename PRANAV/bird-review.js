const { randomUUID } = require("node:crypto");

const MAX_AGE_MS = 2500;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 96;
const MAX_REVIEWS = 4;

const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 96;
const fresh = (at, now) => Number.isFinite(at) && now >= at && now - at <= MAX_AGE_MS;
const trackFor = (state, id) => !state || state.learning || state.shake || state.overflow ? undefined :
  state.tracks?.find(t => t.id === id && !t.missed && !t.dense && t.classification !== "rejected" && t.classification !== "debris");

function createBirdReview({ findLive, crop, verify, clock = Date.now }) {
  const frames = new Map(), pending = new Set();
  let bytes = 0;
  const keyOf = (streamId, frameId) => `${streamId}:${frameId}`;
  function prune(now) {
    for (const [key, frame] of frames) {
      if (fresh(frame.at, now) && bytes <= MAX_BYTES && frames.size <= MAX_FRAMES) break;
      frames.delete(key);
      bytes -= frame.jpeg.length;
    }
  }
  function record(live, frame, state) {
    if (frame.streamId !== live.streamId || !live.bot.active || !state.generation ||
        !Number.isFinite(frame.t) || frame.t !== state.t || state.learning || state.shake || state.overflow || !state.tracks.length) return;
    const now = clock();
    if (!fresh(frame.at, now) || frame.jpeg.length > MAX_BYTES) return;
    const key = keyOf(frame.streamId, frame.frameId);
    if (frames.has(key)) return;
    frames.set(key, { ...frame, live, state });
    bytes += frame.jpeg.length;
    prune(now);
  }
  async function review(request, airport) {
    const { cameraId, streamId, frameId, trackId } = request || {};
    if (!identity(cameraId) || !identity(streamId) || !Number.isSafeInteger(frameId) || frameId < 1 ||
        !Number.isSafeInteger(trackId) || trackId < 1)
      return { status: "unavailable", reason: "invalid_reference" };
    const live = findLive(cameraId, airport);
    if (!live || (airport && live.airport !== airport) || live.streamId !== streamId)
      return { status: "unavailable", reason: "unknown_evidence" };
    prune(clock());
    const frame = frames.get(keyOf(streamId, frameId));
    const current = () => live.bot.active && findLive(cameraId, airport) === live && live.streamId === streamId &&
      fresh(frame?.at, clock()) && frame.state.generation === live.lastState?.generation && trackFor(live.lastState, trackId);
    const track = frame?.live === live && trackFor(frame.state, trackId);
    if (!track || !current()) return { status: "unavailable", reason: "unknown_evidence" };
    const key = `${streamId}:${trackId}`;
    if (pending.size >= MAX_REVIEWS || pending.has(key)) return { status: "unavailable", reason: "busy" };
    pending.add(key);
    try {
      const image = await crop(frame.jpeg, track.bbox);
      if (!image || !current()) return { status: "unavailable", reason: "evidence_expired" };
      const verdict = await verify(image);
      if (verdict?.status !== "verified" || !["gemini", "local"].includes(verdict.source) ||
          !["bird", "not_bird", "uncertain"].includes(verdict.verdict))
        return { status: "unavailable", reason: verdict?.reason || "provider_unavailable" };
      return {
        ...verdict, reviewId: randomUUID(), evidenceRef: { airport: live.airport, cameraId, streamId, frameId, trackId,
          generation: frame.state.generation, t: frame.t },
        application: current() ? "advisory" : "historical",
        crop: image, // for the opt-in training set (SAVE_JUDGE_IMAGES); the route removes it before replying
      };
    } finally { pending.delete(key); }
  }
  return { record, review, prune: () => prune(clock()) };
}

module.exports = { createBirdReview };
