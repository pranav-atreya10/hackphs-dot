import { MAX_FRAME_AGE, validBox } from './bird-evidence.js';

const BOX_LIMIT = 8;
const MIN_NATIVE_PX = 7; // Experimental advisory eligibility, not a reliability threshold.

function isFresh(receivedAt, now) {
  return Number.isFinite(receivedAt) && receivedAt <= now && now - receivedAt <= MAX_FRAME_AGE;
}

function exactPair(feed, now) {
  const pair = feed.birdEvidence;
  if (feed.offline || feed.demo || feed.fallbackActive || pair?.source !== 'server') return null;
  const { frame, state, generation } = pair;
  if (!frame || typeof frame.streamId !== 'string' || !frame.streamId ||
      (feed.birdStreamId != null && feed.birdStreamId !== frame.streamId) ||
      !Number.isSafeInteger(frame.frameId) || frame.frameId < 0 ||
      !Number.isFinite(frame.frameT) || frame.frameT !== state?.t ||
      !isFresh(frame.frameReceivedAt, now) ||
      typeof generation !== 'string' || !generation.trim() || state.generation !== generation ||
      !Array.isArray(state.tracks) || state.shake || state.learning || state.overflow ||
      (state.motion && (!state.motion.ready || state.motion.shake || state.motion.overflow))) return null;
  // The detector lease can expire before the next feed refresh clears the pair.
  const { detector } = feed;
  if (detector && (detector.mode !== 'server' || detector.generation !== generation ||
      detector.now() >= detector.expiresAt)) return null;
  const { width, height } = frame.bitmap || {};
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 ? pair : null;
}

function eligibleTracks(pair) {
  const eligible = new Map();
  const { width, height } = pair.frame.bitmap;
  for (const tr of pair.state.tracks) {
    if (!Number.isSafeInteger(tr?.id) || tr.id < 0 || eligible.has(tr.id) ||
        tr.missed || tr.dense || tr.classification === 'rejected' || tr.classification === 'debris' ||
        !validBox(tr.bbox)) continue;
    const { x, y, w, h } = tr.bbox;
    const nativeWidth = Math.min(w, 1 - x) * width, nativeHeight = Math.min(h, 1 - y) * height;
    if (nativeWidth <= 0 || nativeHeight <= 0 || Math.max(nativeWidth, nativeHeight) < MIN_NATIVE_PX) continue;
    eligible.set(tr.id, { id: tr.id, bbox: tr.bbox, nativeWidth, nativeHeight });
  }
  return eligible;
}

// Call when ready to dispatch one job. A pick reserves its samples immediately; copy
// the returned bitmap's pixels before yielding, since the feed still owns the bitmap.
export function createV41Scheduler() {
  const cameras = new Map();
  return {
    clear(cameraId) {
      if (cameraId === undefined) cameras.clear();
      else cameras.delete(cameraId);
    },
    pick(feeds, now = Date.now()) {
      if (!Number.isFinite(now)) return null;
      for (const [id, cursor] of cameras) {
        // A feed can be removed and re-added while its last frame is still fresh.
        if (!feeds.has(id) && !isFresh(cursor?.receivedAt, now)) cameras.delete(id);
      }
      for (const id of feeds.keys()) if (!cameras.has(id)) cameras.set(id, null);

      for (const [cameraId, previous] of cameras) {
        const feed = feeds.get(cameraId);
        if (!feed || feed.cameraId !== cameraId || typeof cameraId !== 'string' || !cameraId) continue;
        const pair = exactPair(feed, now);
        if (!pair) continue;
        const { frame: { streamId, frameId, frameReceivedAt }, generation, source } = pair;
        let cursor = previous;
        if (cursor?.streamId !== streamId || cursor.generation !== generation) {
          cursor = { streamId, generation, frameId: -1, receivedAt: frameReceivedAt,
            order: new Set(), sampled: new Set() };
          cameras.set(cameraId, cursor);
        }
        if (frameId < cursor.frameId) continue;
        if (frameId > cursor.frameId) {
          cursor.frameId = frameId;
          cursor.receivedAt = frameReceivedAt;
          cursor.sampled.clear();
        }

        const eligible = eligibleTracks(pair);
        // Ordered sets append newcomers behind waiting tracks, regardless of payload order.
        for (const id of cursor.order) if (!eligible.has(id)) cursor.order.delete(id);
        for (const id of eligible.keys()) cursor.order.add(id);
        const tracks = [];
        for (const id of cursor.order) {
          if (cursor.sampled.has(id)) continue;
          const tr = eligible.get(id);
          tracks.push({ ...tr, bbox: { ...tr.bbox }, key: JSON.stringify([cameraId, source, streamId, generation, id]) });
          if (tracks.length === BOX_LIMIT) break;
        }
        if (!tracks.length) continue;
        for (const { id } of tracks) {
          cursor.sampled.add(id);
          cursor.order.delete(id);
          cursor.order.add(id);
        }
        cameras.delete(cameraId);
        cameras.set(cameraId, cursor);
        return { feed, pair, tracks };
      }
      return null;
    },
  };
}
