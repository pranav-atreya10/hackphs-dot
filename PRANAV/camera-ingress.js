const { createHash } = require("node:crypto");

const STALE_MS = 10_000;
const CONFIG_TTL_MS = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isDeviceId = value => typeof value === "string" && uuid.test(value);
const isLiveSource = source => source === "live";
const isJPEG = frame => Buffer.isBuffer(frame) && frame.length >= 100 && frame.length <= 900_000 &&
  frame[0] === 255 && frame[1] === 216 && frame[frame.length - 2] === 255 && frame[frame.length - 1] === 217;

const cameraIdentity = ({ airport, principal }, transport, deviceId) =>
  createHash("sha256").update(JSON.stringify([airport, principal, transport, deviceId.toLowerCase()])).digest("hex");

function createCameraRegistry({ now = Date.now, onStatus }) {
  const entries = new Map();
  const status = (live, online, at) => ({ cameraId: live.cameraId, cameraLabel: live.cameraLabel, airport: live.airport, online, at });
  const current = live => entries.get(live.cameraId) === live;
  const fresh = live => current(live) && live.lastSeen !== null && now() - live.lastSeen < STALE_MS;
  function remove(live) {
    if (!current(live)) return;
    entries.delete(live.cameraId);
    if (live.lastSeen !== null) onStatus(live, status(live, false, now()));
  }
  function frame(live) {
    if (!current(live)) return false;
    const at = now();
    if (!fresh(live) || at - live.statusAt >= 2000) {
      live.statusAt = at;
      live.lastSeen = at;
      onStatus(live, status(live, true, at));
    } else {
      live.lastSeen = at;
    }
    return true;
  }
  function sweep() {
    for (const live of entries.values()) {
      if (live.lastSeen !== null && !fresh(live)) remove(live);
      else if (live.lastSeen === null && now() - live.createdAt >= CONFIG_TTL_MS) remove(live);
    }
  }
  return {
    get: id => entries.get(id),
    current, fresh, frame, remove, sweep,
    add(live) {
      const old = entries.get(live.cameraId);
      if (old) remove(old);
      entries.set(live.cameraId, Object.assign(live, { lastSeen: null, createdAt: now(), statusAt: null }));
      return live;
    },
    active: () => [...entries.values()].filter(fresh),
    presence: live => status(live, true, live.lastSeen),
  };
}

module.exports = { cameraIdentity, createCameraRegistry, isDeviceId, isJPEG, isLiveSource };
