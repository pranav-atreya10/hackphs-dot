// Server-side bot: runs Vivan's DetectionEngine on the video a phone streams in.
//
//   phone ──camera:frame (JPEG)──► server ──decode──► 320 px copy ──► DetectionEngine
//     ├─ every frame: relayed to towers as camera:frame, plus bot:state (tracks/flocks/risk) for the overlay
//     └─ engine 'event' ──► snapshot crop from the full frame ──► relayCameraEvent (store, AI step, towers)
//
// The bot owns streamed detection. On failure it reports unavailable and retries on incoming frames.
const sharp = require("sharp");
sharp.cache?.(false);
sharp.concurrency?.(1);
const path = require("path");
const { pathToFileURL } = require("url");
const { randomUUID } = require("crypto");

const ENABLED = (process.env.SERVER_BOT || "on") !== "off";
const PROC_W = 320;                 // Vivan's engine is tuned for 320 px wide frames
const BUDGET_MS = 60;
const RETRY_MS = 20000;
const FRESH_MS = 3000;
const DEFAULT_PRESET = process.env.BOT_PRESET || "phone_15fps";
const enginePath = pathToFileURL(path.join(__dirname, "public/detection/index.js")).href;
let enginePromise = null;
const loadEngine = () => (enginePromise ??= import(enginePath));

// Decode and resize in libvips' native worker pool instead of blocking every camera's HTTP/socket traffic.
async function decode(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: 16_777_216 })
    .resize({ width: PROC_W, height: 1280, fit: "inside", withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Decode the original resolution only when an alert needs evidence.
async function crop(buf, box, options = {}) {
  const image = sharp(buf, { limitInputPixels: 16_777_216 });
  const { width: W, height: H } = await image.metadata();
  if (options.review) {
    const { x, y, w, h } = box;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1 ||
        Math.max(w * W, h * H) < 24) return null;
  }
  const x0 = Math.max(0, Math.floor(box.x * W)), y0 = Math.max(0, Math.floor(box.y * H));
  const cw = Math.min(W - x0, Math.ceil(box.w * W)), ch = Math.min(H - y0, Math.ceil(box.h * H));
  if (cw < 4 || ch < 4) return null;
  const cropped = image.extract({ left: x0, top: y0, width: cw, height: ch });
  if (options.review) cropped.resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true });
  return (await cropped.jpeg({ quality: 75 }).toBuffer()).toString("base64");
}

// Small, overlay-only view of the engine state (tracks, flocks, primary, risk) sent with each frame.
function compact(st) {
  return {
    t: st.t, risk: st.risk.level, reasons: st.risk.reasons,
    // Why the bot may be waiting: still learning the background, or the camera is moving.
    learning: !st.motion.ready, shake: !!st.motion.shake, overflow: !!st.motion.overflow,
    primary: st.primary && { size: st.primary.size, classification: st.primary.classification, eta_seconds: st.primary.eta_seconds, eta_basis: st.primary.eta_basis, bearing_deg: st.primary.bearing_deg, flap_hz: st.primary.flap_hz, heading: st.primary.heading?.name, kind: st.primary.kind },
    tracks: st.tracks.map((t) => ({ id: t.id, bbox: t.bbox, classification: t.classification, flap_hz: t.flap_hz, eta_seconds: t.eta_seconds, eta_basis: t.eta_basis, is_flock: t.is_flock, missed: t.missed, dense: t.dense, trail: t.trail.slice(-12) })),
    flocks: st.flocks.map((f) => ({ id: f.id, bbox: f.bbox, size: f.size, eta_seconds: f.eta_seconds, eta_basis: f.eta_basis })),
    fps: st.stats.fps, proc_ms: st.stats.proc_ms,
  };
}

class CameraBot {
  constructor({ cameraId, onEvent, onState, onStatus, now = () => performance.now() }) {
    Object.assign(this, { cameraId, onEvent, onState, onStatus, now });
    this.engine = null; this.avgMs = 0; this.busy = false; this.dropped = 0;
    this.events = [];
    this.mode = ENABLED ? "starting" : "unavailable";
    this.reason = ENABLED ? "waiting for usable results" : "server detector disabled";
    this.retryAt = 0; this.timed = 0;
    this.state = null; this.resultAt = null; this.startedAt = null;
  }

  configure({ camera, corridor, surveyId, camera_id, preset }) {
    this.config = { camera, corridor, surveyId, camera_id, preset };
    if (this.engine) this.apply();
  }
  apply() {
    const c = this.config || {};
    // Vivan's tuning presets (params.js). Streamed phones run at ~15 fps, so that preset is the default.
    const presets = [].concat(c.preset || DEFAULT_PRESET);
    for (const name of presets) if (this.presets?.[name]) this.engine.setConfig(this.presets[name]);
    // A stronger learning rate clears first-frame ghosts with eight frames instead of fifteen.
    if (presets.includes("phone_15fps")) this.engine.setConfig({ motion: { warmupFrames: 8, warmupAlpha: 0.4 } });
    if (c.camera) this.engine.setCamera(c.camera);
    if (c.camera_id) this.engine.setConfig({ camera_id: c.camera_id });
    this.engine.setCorridor(c.corridor, { surveyId: c.surveyId });
  }

  async frame(buf, t, frame) {
    this.expire();
    if (!ENABLED || this.now() < this.retryAt) return false;
    if (this.busy) { this.dropped++; return this.active; }
    if (this.mode === "unavailable") {
      this.avgMs = 0; this.timed = 0;
      this.setMode("starting", "waiting for usable results");
    }
    this.busy = true;
    const started = this.startedAt = this.now();
    try {
      if (!this.engine) {
        const { DetectionEngine, PRESETS } = await loadEngine();
        if (this.startedAt !== started) return false;
        this.presets = PRESETS;
        this.engine = new DetectionEngine({ camera_id: this.cameraId });
        this.generation = randomUUID();
        this.apply();
        this.engine.on("event", (ev) => this.events.push(ev));
      }
      const t0 = this.now();
      const img = await decode(buf);
      if (this.startedAt !== started) return false;
      if (this.now() - started >= FRESH_MS) {
        this.stop("results timed out");
        return false;
      }
      const state = compact(this.engine.process(img, t));
      const ms = this.now() - t0;
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
      if (this.now() - started >= FRESH_MS) {
        this.stop("results timed out");
        return false;
      }
      if (++this.timed > 60 && this.avgMs > BUDGET_MS) {
        this.stop("server detector overloaded");
        return false;
      }
      this.resultAt = started;
      const events = this.events.splice(0);
      if (state.learning || state.shake || state.overflow) {
        this.setMode("starting", state.overflow ? "scene motion overflow" : state.shake ? "camera moving" : "learning the background");
        return false;
      }
      this.state = { ...state, generation: this.generation };
      this.setMode("server", null);
      this.onState(this.state, frame);
      for (const ev of events) {
        if (ev.needs_snapshot && ev.crop_box) {
          try { ev.snapshot = await crop(buf, ev.crop_box); }
          catch (err) { console.warn(`snapshot for ${this.cameraId} unavailable: ${err.message}`); }
        }
        if (!this.active) break;
        ev.detected_by = "server";
        this.onEvent(ev, frame, this.state);
      }
    } catch (err) {
      console.warn(`server detector for ${this.cameraId} failed: ${err.message}`);
      this.stop("processing failed; retrying on incoming frames");
    } finally {
      this.busy = false; this.startedAt = null;
    }
    return this.active;
  }

  get active() {
    return this.mode === "server" && this.now() - this.resultAt < FRESH_MS;
  }
  expire() {
    if (this.startedAt !== null && this.now() - this.startedAt >= FRESH_MS) {
      this.stop("results timed out");
    } else if (this.resultAt !== null && this.now() - this.resultAt >= FRESH_MS) {
      this.invalidate("no fresh server results");
    }
  }
  setMode(mode, reason) {
    if (mode !== "server") this.state = null;
    if (this.mode === mode && this.reason === reason) return;
    this.mode = mode; this.reason = reason;
    this.onStatus();
  }
  invalidate(reason) {
    this.engine = null; this.state = null; this.resultAt = null;
    this.startedAt = null;
    this.events.length = 0;
    this.setMode("unavailable", reason);
  }
  stop(reason) {
    this.retryAt = this.now() + RETRY_MS;
    this.invalidate(reason);
  }
  status() {
    const expired = this.resultAt !== null && this.now() - this.resultAt >= FRESH_MS;
    return { cameraId: this.cameraId, mode: expired ? "unavailable" : this.mode,
      reason: expired ? "no fresh server results" : this.reason, max_result_age_ms: FRESH_MS,
      generation: this.active ? this.generation : null,
      capabilities: { video: true, drone_audio: false }, avg_ms: Math.round(this.avgMs), dropped: this.dropped };
  }
  freshState() { return this.active ? this.state : null; }
  remainingMs() { return this.active ? Math.max(0, FRESH_MS - (this.now() - this.resultAt)) : 0; }
}

async function checkVideoDetector() {
  if (!ENABLED) return 'disabled';
  const { DetectionEngine } = await loadEngine();
  const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#709acd' } }).jpeg().toBuffer();
  const state = new DetectionEngine().process(await decode(jpeg), 0);
  return state?.motion && state?.risk ? 'ready' : 'unavailable';
}

module.exports = { CameraBot, BOT_ENABLED: ENABLED, checkVideoDetector,
  cropBirdReview: (jpeg, box) => crop(jpeg, box, { review: true }) };
