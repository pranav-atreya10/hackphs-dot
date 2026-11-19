const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(join(__dirname, "..", "public", "js", "camera.js"), "utf8").replace(/^import .*$/gm, "");
const pending = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(getUserMedia, { modelMic } = {}) {
  const { DetectorStatus } = await import("../public/js/detector-status.mjs");
  const elements = new Map(), values = new Map(), messages = [], revoked = [];
  const canvas = {
    clearRect() {}, drawImage() {}, putImageData() {}, getImageData() { return {}; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, setLineDash() {}, stroke() {}, fillText() {},
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", readyState: 2, width: 640, height: 480, currentTime: 1, dataset: {}, files: [],
      textContent: "", children: [], options: [], previousSibling: {},
      events: {}, attrs: {}, addEventListener(name, fn) { this.events[name] = fn; },
      getAttribute(name) { return this.attrs[name]; }, setAttribute(name, val) { this.attrs[name] = val; },
      removeAttribute(name) { delete this[name]; }, getContext() { return canvas; },
      classList: { add() {}, remove() {} }, getBoundingClientRect() { return { width: 640, height: 480, left: 0, top: 0 }; },
      prepend() {}, canPlayType() { return "probably"; }, add(option) { this.options.push(option); },
      play() { return Promise.resolve(); }, pause() {}, load() {},
      toBlob(done) { done({ arrayBuffer: async () => new ArrayBuffer(100) }); },
    });
    return elements.get(id);
  }
  const hooks = {};
  const socket = { id: "socket", connected: true, on(name, fn) { hooks[name] = fn; }, timeout() { return this; },
    emit(name, ...args) { messages.push([name, ...args]); } };
  let time = 10_000;
  const context = {
    console, URLSearchParams, crypto: webcrypto, devicePixelRatio: 1, performance: { now: () => time },
    URL: { createObjectURL: () => "blob:local-video", revokeObjectURL: url => revoked.push(url) },
    navigator: { userAgent: "iPhone", mediaDevices: { getUserMedia } },
    location: { search: "", origin: "http://localhost", protocol: "http:", hostname: "localhost" },
    document: { getElementById: element, createElement: tag => element(tag), querySelector: () => element("sSent"), addEventListener() {} },
    localStorage: { getItem: key => values.get(key), setItem: (key, val) => values.set(key, val) },
    addEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setInterval, clearInterval, setTimeout, clearTimeout,
    fetch: async () => ({ json: async () => [{ title: "Test", expect: "Example", file: "demo.mp4" }] }),
    Worker: class { postMessage() {} }, Option: class {},
    SCENARIOS: {}, PRESETS: {}, SyntheticSky: class {},
    DetectionEngine: class { setConfig() {} setAudioProbability() {} setCorridor() {} },
    DroneAudioModel: { load: async () => ({}) }, startModelMic: modelMic,
    DetectorStatus: class extends DetectorStatus { constructor() { super(() => time, () => time); } },
    refreshSocketAuth() {},
    signIn: async () => ({ mode: "key", socketAuth: async extra => extra }),
    io: () => socket,
  };
  const app = runInNewContext(`${source}\n({ start, stop, streamFrame, loop, finishCorridor, setDrawing: points => { drawing = points; } })`, context);
  await tick();
  hooks.connect();
  return { app, element, messages, revoked, values, hooks, advance: ms => { time += ms; } };
}

test("webcam denial keeps the source on webcam and sends no operational packets", async () => {
  const denied = Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
  const { app, element, messages } = await setup(async () => { throw denied; });
  await app.start();
  assert.equal(element("source").value, "webcam");
  assert.match(element("statusLine").textContent, /Camera access was blocked/);
  assert.deepEqual(messages, []);
});

test("uploaded playback is local and Stop detaches and revokes its object URL", async () => {
  const { app, element, messages, revoked } = await setup(() => assert.fail("request for a media device"));
  element("source").value = "clip";
  element("clip").files = [{}];
  await app.start();
  assert.match(element("statusLine").textContent, /Simulation.*local only/);
  app.stop();
  assert.deepEqual(messages, []);
  assert.equal(element("video").src, undefined);
  assert.deepEqual(revoked, ["blob:local-video"]);
});

test("Stop releases a late webcam permission result and a late microphone setup", async () => {
  const webcam = pending(), micSetup = pending();
  let videoStops = 0, audioStops = 0, contextsClosed = 0;
  const track = { stop() { videoStops++; }, readyState: "live", muted: false, enabled: true };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const audioStream = { getTracks: () => [{ stop() { audioStops++; } }] };
  const { app, element, messages } = await setup(
    constraints => constraints.audio ? Promise.resolve(audioStream) : webcam.promise,
    { modelMic: () => micSetup.promise },
  );
  const first = app.start();
  app.stop();
  webcam.resolve(stream);
  await first;
  assert.equal(videoStops, 1);
  assert.deepEqual(messages, []);
  await app.start();
  assert.equal(messages[0][0], "camera:config");
  assert.equal(messages[0][1].source, "live");
  const enabling = element("mic").events.click();
  await tick();
  app.streamFrame(1);
  app.stop();
  micSetup.resolve(() => { contextsClosed++; });
  await enabling;
  assert.equal(videoStops, 2);
  assert.equal(audioStops, 1);
  assert.equal(contextsClosed, 1);
  assert.equal(element("mic").getAttribute("aria-pressed"), "false");
  assert.deepEqual(messages.map(([event]) => event), ["camera:config", "camera:stop"]);
});

test("live frames carry provenance and an ended track does not send its last image", async () => {
  const track = { stop() {}, readyState: "live", muted: false, enabled: true };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const { app, element, messages, advance } = await setup(async () => stream);
  await app.start();
  app.streamFrame(1);
  await tick();
  assert.equal(messages[1][0], "camera:frame");
  assert.equal(messages[1][1].source, "live");
  messages[1].at(-1)(null, { ok: true, bot: "server" });
  assert.equal(element("sSent").textContent, 1);
  track.readyState = "ended";
  advance(100);
  element("video").currentTime += 1;
  app.streamFrame(2);
  await tick();
  assert.equal(messages.length, 2);
  app.stop();
});

test("a drawn mask is only an inactive draft and does not send a config", async () => {
  const { app, element, values } = await setup(() => assert.fail("request for a media device"));
  app.setDrawing([[0.1, 0.1], [0.2, 0.2], [0.3, 0.1]]);
  app.finishCorridor();
  assert.match(element("corridorHint").textContent, /Draft preview only/);
  assert.equal(values.has("skysentry.corridor"), false);
});

test("stream mode clears detector results when authority is lost or the result expires", async () => {
  const track = { stop() {}, readyState: "live", muted: false, enabled: true };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const { app, element, hooks, advance } = await setup(async () => stream);
  element("video").readyState = 0;
  await app.start();
  const state = { generation: "g1", t: 1.25, risk: "green", tracks: [], flocks: [] };
  hooks["bot:status"]({ mode: "server", generation: "g1" });
  hooks["bot:state"]({ mode: "server", streamId: "s1", frameId: 1, at: 9_975, remaining_ms: 100, state });
  element("video").readyState = 2;
  app.loop();
  assert.equal(element("riskLvl").textContent, "GREEN");
  advance(75);
  app.loop();
  assert.equal(element("riskLvl").textContent, "UNKNOWN");
  hooks["bot:state"]({ mode: "server", streamId: "s1", frameId: 2, at: 10_075, remaining_ms: 100, state });
  hooks["bot:status"]({ mode: "unavailable" });
  app.loop();
  assert.equal(element("riskLvl").textContent, "UNKNOWN");
  assert.match(element("bannerText").textContent, /unavailable/);
  app.stop();
});
