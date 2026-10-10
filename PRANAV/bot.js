// Server-side bot: runs Vivan's DetectionEngine on the video a phone streams in.
//
//   phone ──camera:frame (JPEG)──► server ──decode──► 320 px copy ──► DetectionEngine
//     ├─ every frame: relayed to towers as camera:frame, plus bot:state (tracks/flocks/risk) for the overlay
//     └─ engine 'event' ──► snapshot crop from the full frame ──► relayCameraEvent (store, AI step, towers)
//
// The bot backs off when it can't keep up or fails; towers then run their own copy of the engine as a
// fallback (see public/js/tower.js) and send events with detected_by = "tower".
const jpeg = require("jpeg-js");
const path = require("path");
const { pathToFileURL } = require("url");

const ENABLED = (process.env.SERVER_BOT || "on") !== "off";
const PROC_W = 320;                 // Vivan's engine is tuned for 320 px wide frames
const BUDGET_MS = 60;               // average decode+detect time above this = overloaded, hand over to towers
const enginePath = pathToFileURL(path.join(__dirname, "public/detection/index.js")).href;
let enginePromise = null;
const loadEngine = () => (enginePromise ??= import(enginePath));

// Box-filter downscale of an RGBA frame to PROC_W wide.
function downscale(src, w, h) {
  const tw = Math.min(PROC_W, w), th = Math.round((h * tw) / w), out = new Uint8ClampedArray(tw * th * 4);
  const sx = w / tw, sy = h / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
      const o = (y * tw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: tw, height: th };
}

// JPEG crop (normalized box, padded by the engine) from the last full-resolution frame.
function crop(frame, box) {
  const { width: W, height: H, data } = frame;
  const x0 = Math.max(0, Math.floor(box.x * W)), y0 = Math.max(0, Math.floor(box.y * H));
  const cw = Math.min(W - x0, Math.ceil(box.w * W)), ch = Math.min(H - y0, Math.ceil(box.h * H));
  if (cw < 4 || ch < 4) return null;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) data.copy ? data.copy(out, y * cw * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + cw) * 4)
    : out.set(data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + cw) * 4), y * cw * 4);
  return jpeg.encode({ data: out, width: cw, height: ch }, 75).data.toString("base64");
}

// Small, overlay-only view of the engine state (tracks, flocks, primary, risk) sent with each frame.
function compact(st) {
  return {
    t: st.t, risk: st.risk.level, reasons: st.risk.reasons,
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
    this.active = ENABLED; this.reason = ENABLED ? null : "SERVER_BOT=off";
  }

  configure({ camera, corridor, camera_id }) {
    this.config = { camera, corridor, camera_id };
    if (this.engine) this.apply();
  }
  apply() {
    const c = this.config || {};
    if (c.camera) this.engine.setCamera(c.camera);
    if (c.camera_id) this.engine.setConfig({ camera_id: c.camera_id });
    if (Array.isArray(c.corridor)) this.engine.setCorridor(c.corridor);
  }

  async frame(buf, t) {
    if (!this.active) return false;
    if (this.busy) { this.dropped++; return true; }   // still working on the previous frame: skip this one
    this.busy = true;
    const t0 = performance.now();
    try {
      if (!this.engine) {
        const { DetectionEngine } = await loadEngine();
        this.engine = new DetectionEngine({ camera_id: this.cameraId });
        this.apply();
        this.engine.on("event", (ev) => {
          if (ev.needs_snapshot && ev.crop_box && this.last) ev.snapshot = crop(this.last, ev.crop_box);
          ev.detected_by = "server";
          this.onEvent(ev);
        });
      }
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
      this.last = img;
      const st = this.engine.process(downscale(img.data, img.width, img.height), t);
      this.onState(compact(st));
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
      if (this.avgMs > BUDGET_MS && this.engine.stats.frames > 60) this.stop(`overloaded (${Math.round(this.avgMs)} ms per frame)`);
    } catch (err) {
      this.stop(`error: ${err.message}`);
    } finally {
      this.busy = false;
    }
    return this.active;
  }

  stop(reason) {
    if (!this.active) return;
    this.active = false; this.reason = reason;
    console.warn(`server bot for ${this.cameraId} handed over to towers: ${reason}`);
    this.onStatus();
  }
  status() { return { cameraId: this.cameraId, mode: this.active ? "server" : "tower", reason: this.reason, avg_ms: Math.round(this.avgMs), dropped: this.dropped }; }
}

module.exports = { CameraBot, BOT_ENABLED: ENABLED };
