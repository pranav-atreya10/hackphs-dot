// Server-side bot: runs Vivan's DetectionEngine on the video a phone streams in.
//
//   phone ──camera:frame (JPEG)──► server ──decode──► 320 px copy ──► DetectionEngine
//     ├─ every frame: relayed to towers as camera:frame, plus bot:state (tracks/flocks/risk) for the overlay
//     └─ engine 'event' ──► snapshot crop from the full frame ──► relayCameraEvent (store, AI step, towers)
//
// The bot backs off when it can't keep up or fails; towers then run their own copy of the engine as a
// fallback (see public/js/tower.js) and send events with detected_by = "tower".
const sharp = require("sharp");
const path = require("path");
const { pathToFileURL } = require("url");

const ENABLED = (process.env.SERVER_BOT || "on") !== "off";
const PROC_W = 320;                 // Vivan's engine is tuned for 320 px wide frames
const BUDGET_MS = 60;               // average decode+detect time above this = overloaded, hand over to towers
const RETRY_MS = 20000;
const DEFAULT_PRESET = process.env.BOT_PRESET || "phone_15fps";             // after handing over, try running on the server again this often
const enginePath = pathToFileURL(path.join(__dirname, "public/detection/index.js")).href;
let enginePromise = null;
const loadEngine = () => (enginePromise ??= import(enginePath));
const COCO_LABELS = new Set(('person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush').split(','));

// Decode and resize in libvips' native worker pool instead of blocking every camera's HTTP/socket traffic.
async function decode(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: 16_777_216 })
    .resize({ width: PROC_W, height: 1280, fit: "inside", withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Decode the original resolution only when an alert needs evidence.
async function crop(buf, box) {
  const image = sharp(buf, { limitInputPixels: 16_777_216 });
  const { width: W, height: H } = await image.metadata();
  const x0 = Math.max(0, Math.floor(box.x * W)), y0 = Math.max(0, Math.floor(box.y * H));
  const cw = Math.min(W - x0, Math.ceil(box.w * W)), ch = Math.min(H - y0, Math.ceil(box.h * H));
  if (cw < 4 || ch < 4) return null;
  return (await image.extract({ left: x0, top: y0, width: cw, height: ch }).jpeg({ quality: 75 }).toBuffer()).toString("base64");
}

// Small, overlay-only view of the engine state (tracks, flocks, primary, risk) sent with each frame.
function compact(st) {
  return {
    t: st.t, risk: st.risk.level, reasons: st.risk.reasons,
    // Why the bot may be waiting: still learning the background, or the camera is moving.
    learning: !st.motion.ready, shake: !!st.motion.shake,
    primary: st.primary && { size: st.primary.size, classification: st.primary.classification, eta_seconds: st.primary.eta_seconds, bearing_deg: st.primary.bearing_deg, flap_hz: st.primary.flap_hz, heading: st.primary.heading?.name, kind: st.primary.kind },
    tracks: st.tracks.map((t) => ({ id: t.id, bbox: t.bbox, classification: t.classification, flap_hz: t.flap_hz, eta_seconds: t.eta_seconds, is_flock: t.is_flock, trail: t.trail.slice(-12) })),
    flocks: st.flocks.map((f) => ({ id: f.id, bbox: f.bbox, size: f.size, eta_seconds: f.eta_seconds })),
    fps: st.stats.fps, proc_ms: st.stats.proc_ms,
  };
}

class CameraBot {
  constructor({ cameraId, onEvent, onState, onStatus }) {
    Object.assign(this, { cameraId, onEvent, onState, onStatus });
    this.engine = null; this.last = null; this.avgMs = 0; this.busy = false; this.dropped = 0;
    this.events = [];
    this.active = ENABLED; this.reason = ENABLED ? null : "SERVER_BOT=off"; this.retryAt = 0; this.timed = 0;
  }

  configure({ camera, corridor, camera_id, preset }) {
    this.config = { camera, corridor, camera_id, preset };
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
    if (Array.isArray(c.corridor)) this.engine.setCorridor(c.corridor);
  }

  async frame(buf, t) {
    if (!this.active) {
      if (!ENABLED || Date.now() < this.retryAt) return false;
      this.active = true; this.reason = null; this.avgMs = 0; this.timed = 0;   // take the camera back
      console.log(`server bot for ${this.cameraId} is running again`);
      this.onStatus();
    }
    if (this.busy) { this.dropped++; return true; }   // still working on the previous frame: skip this one
    this.busy = true;
    try {
      if (!this.engine) {
        const { DetectionEngine, PRESETS } = await loadEngine();
        this.presets = PRESETS;
        this.engine = new DetectionEngine({ camera_id: this.cameraId });
        this.apply();
        this.engine.on("event", (ev) => this.events.push(ev));
      }
      const t0 = performance.now();   // timed after the engine has loaded, so start-up isn't counted as slowness
      const img = await decode(buf);
      this.last = buf;
      const st = this.engine.process(img, t);
      this.state = compact(st);
      this.onState(this.state);
      for (const ev of this.events.splice(0)) {
        if (ev.needs_snapshot && ev.crop_box) {
          try { ev.snapshot = await crop(buf, ev.crop_box); }
          catch (err) { console.warn(`snapshot for ${this.cameraId} unavailable: ${err.message}`); }
        }
        ev.detected_by = "server";
        this.onEvent(ev);
      }
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
      if (++this.timed > 60 && this.avgMs > BUDGET_MS) this.stop(`overloaded (${Math.round(this.avgMs)} ms per frame)`);
    } catch (err) {
      this.stop(`error: ${err.message}`);
    } finally {
      this.busy = false;
    }
    return this.active;
  }

  stop(reason) {
    if (!this.active) return;
    this.active = false; this.reason = reason; this.retryAt = Date.now() + RETRY_MS;
    console.warn(`server bot for ${this.cameraId} handed over to towers: ${reason}`);
    this.onStatus();
  }
  applyLabel(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const { trackId, label, score, source, bbox, frameT } = payload;
    if (!this.active || !this.engine || source !== 'coco' || !Number.isSafeInteger(trackId)) return false;
    if (!Number.isFinite(score) || score < 0 || score > 1 || (label === null ? score !== 0 : !COCO_LABELS.has(label))) return false;
    if (!Number.isFinite(frameT) || Math.abs(this.engine.lastT - frameT) > 2.5) return false;
    if (!bbox || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(bbox[k])) || bbox.w <= 0 || bbox.h <= 0 || bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.w > 1.01 || bbox.y + bbox.h > 1.01) return false;
    const track = this.engine.tracker.tracks.find(tr => tr.id === trackId && tr.confirmed);
    if (!track) return false;
    const b = this.state?.tracks.find(tr => tr.id === trackId)?.bbox;
    if (!b) return false;
    const shift = Math.hypot(b.x + b.w / 2 - bbox.x - bbox.w / 2, b.y + b.h / 2 - bbox.y - bbox.h / 2);
    if (shift > Math.max(0.08, 2 * Math.max(b.w, b.h))) return false;
    const ratio = bbox.w * bbox.h / (b.w * b.h);
    if (ratio < 0.2 || ratio > 5) return false;
    const intersection = Math.max(0, Math.min(b.x + b.w, bbox.x + bbox.w) - Math.max(b.x, bbox.x)) * Math.max(0, Math.min(b.y + b.h, bbox.y + bbox.h) - Math.max(b.y, bbox.y));
    if (intersection / (b.w * b.h + bbox.w * bbox.h - intersection) < 0.1) return false;
    this.engine.applyLabel(trackId, label, score, 'coco');
    return true;
  }
  status() { return { cameraId: this.cameraId, mode: this.active ? "server" : "tower", reason: this.reason, avg_ms: Math.round(this.avgMs), dropped: this.dropped }; }
}

module.exports = { CameraBot, BOT_ENABLED: ENABLED };
