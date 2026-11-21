const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const {
  deriveHudState,
  formatTelemetry,
  hasLiveVideoTrack,
  mountCameraHud,
} = require("../public/js/camera-hud.js");

const htmlPath = join(__dirname, "..", "public", "camera.html");
const cssPath = join(__dirname, "..", "public", "css", "camera-hud.css");
const walkthroughPath = join(__dirname, "..", "public", "js", "walkthrough.js");

function createMockDom() {
  const elements = new Map();
  const observers = [];

  function makeElement(id, initial = {}) {
    const classes = new Set(initial.classes || []);
    const listeners = new Map();
    const el = {
      id,
      value: initial.value ?? "",
      hidden: Boolean(initial.hidden),
      textContent: initial.textContent ?? "",
      srcObject: initial.srcObject ?? null,
      dataset: { ...(initial.dataset || {}) },
      classList: {
        add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)),
        contains: name => classes.has(name),
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, detail = {}) {
        let propagationStopped = false;
        const event = {
          type,
          ...detail,
          stopPropagation() { propagationStopped = true; },
          preventDefault() { this.defaultPrevented = true; },
        };
        for (const fn of [...(listeners.get(type) || [])]) {
          fn(event);
        }
        return { event, propagationStopped };
      },
      listenerCount(type) {
        return listeners.get(type)?.size || 0;
      },
    };
    elements.set(id, el);
    return el;
  }

  const view = makeElement("view", { dataset: { hudState: "idle" } });
  makeElement("start", { textContent: "Start" });
  makeElement("empty", { hidden: false, textContent: "Point the camera at the sky by the runway, then press Start." });
  makeElement("source", { value: "webcam" });
  makeElement("mode", { value: "stream" });
  makeElement("conn", { textContent: "Connected", dataset: { ok: "1" } });
  makeElement("statusLine", { textContent: "Not streaming yet." });
  makeElement("overlay", {});
  const trackListeners = new Map();
  const mockTrack = {
    readyState: "live",
    muted: false,
    enabled: true,
    addEventListener(type, fn) {
      if (!trackListeners.has(type)) trackListeners.set(type, new Set());
      trackListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      trackListeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(trackListeners.get(type) || [])]) fn({ type });
    },
  };
  makeElement("video", {
    srcObject: {
      getVideoTracks: () => [mockTrack],
    },
  });
  makeElement("heading", { value: "90" });
  makeElement("fov", { value: "65" });
  makeElement("pitch", { value: "20" });
  makeElement("drawCorridor", { textContent: "Draw draft mask" });
  makeElement("corridorHint", { textContent: "Draft masks do not affect alerts." });
  makeElement("corridorEditor", { dataset: { editing: "false" } });
  makeElement("hudBadge", { hidden: true, dataset: { hudMode: "idle" } });
  makeElement("hudPulse", { dataset: { active: "false" } });
  makeElement("hudBadgeText", { textContent: "" });
  makeElement("hudTelemetry", { textContent: "" });

  let reducedMotion = false;
  const mediaListeners = new Set();
  const mediaQueryList = {
    get matches() { return reducedMotion; },
    addEventListener(type, fn) {
      if (type === "change") mediaListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "change") mediaListeners.delete(fn);
    },
  };

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (!this.disconnected) this.cb([]);
    }
  }

  const doc = {
    querySelector: sel => (sel === ".view" ? view : null),
    getElementById: id => elements.get(id) || null,
  };
  const win = {
    MutationObserver: FakeMutationObserver,
    matchMedia: query => {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return mediaQueryList;
    },
  };

  return {
    doc,
    win,
    elements,
    mockTrack,
    observers,
    notifyMutation: () => observers.forEach(o => o.trigger()),
    setReducedMotion(val) {
      reducedMotion = val;
      for (const fn of [...mediaListeners]) fn({ matches: val });
    },
  };
}

test("camera.html wires viewfinder HUD assets while preserving all camera.js and walkthrough.js hooks", () => {
  const html = readFileSync(htmlPath, "utf8");
  const walkthrough = readFileSync(walkthroughPath, "utf8");

  assert.match(html, /<link\s+rel="stylesheet"\s+href="\/css\/camera-hud\.css">/);
  assert.match(html, /<script\s+src="\/js\/camera-hud\.js"\s+defer><\/script>/);

  for (const corner of ["hud-tl", "hud-tr", "hud-bl", "hud-br"]) {
    assert.match(html, new RegExp(`class="hud-corner ${corner}"`));
  }
  assert.match(html, /id="hudFrame"[^>]*aria-hidden="true"/);
  assert.match(html, /id="hudBadge"[^>]*hidden/);
  assert.match(html, /id="hudPulse"/);
  assert.match(html, /id="hudTelemetry"[^>]*aria-hidden="true"/);
  assert.match(html, /id="corridorEditor"/);

  // Preserve 100% of IDs accessed by camera.js and walkthrough.js.
  const requiredIds = [
    "side", "conn", "who", "whoSub", "signout", "auth",
    "video", "src", "overlay", "banner", "bannerText", "empty",
    "start", "upload", "uploadFile", "statusLine", "phoneQr", "qr", "camUrl",
    "settings", "source", "demoWrap", "demoClip", "scenarioWrap", "scenario",
    "clipWrap", "clip", "mode", "tuning", "cameraId",
    "heading", "fov", "pitch", "lat", "lon", "drawCorridor", "corridorHint",
    "risk", "riskLvl", "riskWhat", "riskWhy",
    "sObjects", "sEta", "sBearing", "sFlap", "sFps", "sSent",
    "coco", "mic", "fakeDrone", "aiStatus", "log",
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `camera.html must preserve #${id}`);
  }

  // Extract camera tour step IDs directly from walkthrough.js and confirm they remain intact.
  const cameraTourSlice = walkthrough.slice(walkthrough.indexOf("camera: ["));
  const tourIds = [...cameraTourSlice.matchAll(/el:\s*'#([a-zA-Z0-9_-]+)'/g)].map(m => m[1]);
  assert.ok(tourIds.length >= 5);
  for (const id of tourIds) {
    assert.match(html, new RegExp(`id="${id}"`), `walkthrough selector #${id} must exist in camera.html`);
  }
});

test("deriveHudState distinguishes live capture pulse from amber PREVIEW / DEMO and disconnected standby", () => {
  const idle = deriveHudState({ startText: "Start", emptyHidden: false });
  assert.equal(idle.hudState, "idle");
  assert.equal(idle.badgeHidden, true);
  assert.equal(idle.pulseActive, false);

  // Awaiting getUserMedia permission (#start says Stop, #empty still visible): never falsely claim live stream.
  const starting = deriveHudState({ startText: "Stop", emptyHidden: false, source: "webcam", mode: "stream", connOk: "1" });
  assert.equal(starting.hudState, "starting");
  assert.equal(starting.badgeHidden, true);
  assert.equal(starting.pulseActive, false);

  // Active live webcam stream to tower.
  const live = deriveHudState({
    startText: "Stop",
    emptyHidden: true,
    source: "webcam",
    mode: "stream",
    connOk: "1",
    statusText: "Streaming · 12 frames sent · bot on the server",
    trackLive: true,
  });
  assert.equal(live.hudState, "live");
  assert.equal(live.badgeMode, "live");
  assert.equal(live.badgeText, "LIVE STREAM");
  assert.equal(live.badgeHidden, false);
  assert.equal(live.pulseActive, true);

  // Every local/demo/synthetic/uploaded configuration shows amber PREVIEW / DEMO with pulse off.
  for (const [source, mode] of [
    ["webcam", "local"],
    ["demo", "stream"],
    ["synthetic", "stream"],
    ["clip", "stream"],
  ]) {
    const preview = deriveHudState({ startText: "Stop", emptyHidden: true, source, mode, connOk: "1", trackLive: true });
    assert.equal(preview.hudState, "preview", `${source}/${mode} must be preview`);
    assert.equal(preview.badgeMode, "preview");
    assert.equal(preview.badgeText, "PREVIEW / DEMO");
    assert.equal(preview.badgeHidden, false);
    assert.equal(preview.pulseActive, false);
  }

  // Disconnected socket or ended webcam track drops out of live pulse into standby.
  const offline = deriveHudState({
    startText: "Stop",
    emptyHidden: true,
    source: "webcam",
    mode: "stream",
    connOk: "0",
    statusText: "Lost the server, reconnecting automatically…",
    trackLive: true,
  });
  assert.equal(offline.hudState, "standby");
  assert.equal(offline.pulseActive, false);

  const endedTrack = deriveHudState({
    startText: "Stop",
    emptyHidden: true,
    source: "webcam",
    mode: "stream",
    connOk: "1",
    trackLive: false,
  });
  assert.equal(endedTrack.hudState, "standby");
  assert.equal(endedTrack.pulseActive, false);
});

test("hasLiveVideoTrack and formatTelemetry handle edge cases cleanly", () => {
  assert.equal(hasLiveVideoTrack(null), true);
  assert.equal(hasLiveVideoTrack({ srcObject: null }), true);
  assert.equal(hasLiveVideoTrack({ srcObject: { getVideoTracks: () => [] } }), false);
  assert.equal(hasLiveVideoTrack({ srcObject: { getVideoTracks: () => [{ readyState: "ended", muted: false, enabled: true }] } }), false);
  assert.equal(hasLiveVideoTrack({ srcObject: { getVideoTracks: () => [{ readyState: "live", muted: true, enabled: true }] } }), false);
  assert.equal(hasLiveVideoTrack({ srcObject: { getVideoTracks: () => [{ readyState: "live", muted: false, enabled: true }] } }), true);

  assert.equal(formatTelemetry({ heading: 90, fov: 65, pitch: 20 }), "HDG 090° · FOV 65° · +20°");
  assert.equal(formatTelemetry({ heading: 360, fov: 110, pitch: -8 }), "HDG 000° · FOV 110° · -8°");
  assert.equal(formatTelemetry({ heading: "", fov: "", pitch: "" }), "HDG ---° · FOV --° · --°");
  assert.equal(
    formatTelemetry({ heading: 270, fov: 65, pitch: 15, corridorEditing: true, draftPoints: 1 }),
    "DRAFT MASK · 1 PT · HDG 270°",
  );
  assert.equal(
    formatTelemetry({ heading: 270, fov: 65, pitch: 15, corridorEditing: true, draftPoints: 3 }),
    "DRAFT MASK · 3 PTS · HDG 270°",
  );
});

test("mountCameraHud syncs live, preview, corridor editing, and reduced-motion states non-invasively", () => {
  const { doc, win, elements, mockTrack, notifyMutation, setReducedMotion } = createMockDom();
  const hud = mountCameraHud(doc, win);
  assert.ok(hud);
  assert.equal(mountCameraHud(doc, win), null, "duplicate mount on the same view is a safe no-op");

  assert.equal(elements.get("view").dataset.hudState, "idle");
  assert.equal(elements.get("hudBadge").hidden, true);
  assert.equal(elements.get("hudTelemetry").textContent, "HDG 090° · FOV 65° · +20°");

  // Simulate live stream start by camera.js.
  elements.get("start").textContent = "Stop";
  elements.get("empty").hidden = true;
  elements.get("statusLine").textContent = "Streaming · 4 frames sent · bot on the server";
  notifyMutation();
  assert.equal(elements.get("view").dataset.hudState, "live");
  assert.equal(elements.get("hudBadge").hidden, false);
  assert.equal(elements.get("hudBadge").dataset.hudMode, "live");
  assert.equal(elements.get("hudBadgeText").textContent, "LIVE STREAM");
  assert.equal(elements.get("hudPulse").dataset.active, "true");

  // If the underlying webcam track ends mid-session, live pulse immediately drops to standby.
  mockTrack.readyState = "ended";
  mockTrack.dispatch("ended");
  assert.equal(elements.get("view").dataset.hudState, "standby");
  assert.equal(elements.get("hudPulse").dataset.active, "false");
  mockTrack.readyState = "live";
  mockTrack.dispatch("unmute");
  assert.equal(elements.get("view").dataset.hudState, "live");
  assert.equal(elements.get("hudPulse").dataset.active, "true");

  // Switch to synthetic demo preview: amber PREVIEW / DEMO badge replaces live pulse.
  elements.get("source").value = "synthetic";
  elements.get("source").dispatch("change");
  assert.equal(elements.get("view").dataset.hudState, "preview");
  assert.equal(elements.get("hudBadge").dataset.hudMode, "preview");
  assert.equal(elements.get("hudBadgeText").textContent, "PREVIEW / DEMO");
  assert.equal(elements.get("hudPulse").dataset.active, "false");
  // Non-invasive guarantee: camera-hud never mutates source, mode, or corridorHint.
  assert.equal(elements.get("source").value, "synthetic");
  assert.equal(elements.get("mode").value, "stream");

  // Corridor draft mask editing workflow: tracks vertex clicks and never blocks overlay events.
  let cameraOverlayClicks = 0;
  elements.get("overlay").addEventListener("click", () => { cameraOverlayClicks++; });
  elements.get("overlay").classList.add("drawing");
  notifyMutation();
  assert.equal(elements.get("view").dataset.corridorEditing, "true");
  assert.equal(elements.get("corridorEditor").dataset.editing, "true");
  assert.equal(elements.get("hudTelemetry").textContent, "DRAFT MASK · 0 PTS · HDG 090°");

  const firstClick = elements.get("overlay").dispatch("click");
  assert.equal(firstClick.propagationStopped, false);
  assert.equal(cameraOverlayClicks, 1);
  assert.equal(elements.get("corridorEditor").dataset.points, "1");
  assert.equal(elements.get("hudTelemetry").textContent, "DRAFT MASK · 1 PT · HDG 090°");

  elements.get("overlay").dispatch("click");
  elements.get("overlay").dispatch("click");
  assert.equal(cameraOverlayClicks, 3);
  assert.equal(elements.get("corridorEditor").dataset.points, "3");
  assert.equal(elements.get("hudTelemetry").textContent, "DRAFT MASK · 3 PTS · HDG 090°");

  // Finishing corridor drawing resets editing state cleanly.
  elements.get("overlay").classList.remove("drawing");
  elements.get("overlay").dispatch("dblclick");
  assert.equal(elements.get("view").dataset.corridorEditing, "false");
  assert.equal(elements.get("corridorEditor").dataset.editing, "false");
  assert.equal(elements.get("corridorEditor").dataset.points, "0");
  assert.equal(elements.get("hudTelemetry").textContent, "HDG 090° · FOV 65° · +20°");

  // Reduced motion preference updates dataset cleanly.
  assert.equal(elements.get("view").dataset.reducedMotion, "false");
  setReducedMotion(true);
  assert.equal(elements.get("view").dataset.reducedMotion, "true");

  // Destroy cleans up listeners and allows clean remount.
  hud.destroy();
  assert.equal(elements.get("heading").listenerCount("input"), 0);
  const remounted = mountCameraHud(doc, win);
  assert.ok(remounted);
  remounted.destroy();
});

test("camera-hud.css enforces pointer-events pass-through, tabular-nums, and prefers-reduced-motion", () => {
  const css = readFileSync(cssPath, "utf8");

  assert.match(css, /\.view\s+\.hud-frame\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.hud-badge\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.hud-telemetry\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /#statusLine/);
  assert.match(css, /#settings input\[type="number"\]/);
  assert.match(css, /\.corridor-editor\[data-editing="true"\]/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*no-preference\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*animation:\s*none\s*!important[\s\S]*transition:\s*none\s*!important/);
});
