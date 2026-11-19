const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const { cameraIdentity, createCameraRegistry, isDeviceId, isJPEG, isLiveSource } = require("../camera-ingress");
const { surveyedCorridor, sanitizeMetrics } = require("../corridor-calibration");
const { createEventJournal } = require("../durable-events");
const { createIncidentJob } = require("../incident-enrichment");

test("camera identity is stable across start and stop but isolated by airport, principal, device and transport", () => {
  const access = { airport: "KPCT", principal: "camera-account" };
  const device = randomUUID();
  const id = cameraIdentity(access, "socket", device);
  assert.equal(id, cameraIdentity({ ...access }, "socket", device.toUpperCase()));
  assert.notEqual(id, cameraIdentity({ ...access, airport: "KJFK" }, "socket", device));
  assert.notEqual(id, cameraIdentity({ ...access, principal: "another-account" }, "socket", device));
  assert.notEqual(id, cameraIdentity(access, "http", device));
  assert.notEqual(id, cameraIdentity(access, "socket", randomUUID()));
  assert.equal(isDeviceId(device), true);
  assert.equal(isDeviceId("iphone-1"), false);
});

test("presence requires frames, expires for either transport, and ignores a stopped generation", () => {
  let time = 0;
  const statuses = [];
  const registry = createCameraRegistry({ now: () => time, onStatus: (_, event) => statuses.push(event) });
  const entry = transport => ({ cameraId: transport, cameraLabel: "Runway east", airport: "KPCT" });
  const socket = registry.add(entry("socket"));
  const http = registry.add(entry("http"));
  const idle = registry.add(entry("idle"));
  assert.deepEqual(registry.active(), []);
  assert.deepEqual(statuses, []);
  registry.frame(socket);
  registry.frame(http);
  assert.deepEqual(registry.active(), [socket, http]);
  assert.deepEqual(registry.presence(http), { ...entry("http"), online: true, at: 0 });
  time = 1_000;
  registry.frame(http);
  assert.equal(statuses.length, 2);
  time = 2_000;
  registry.frame(http);
  assert.equal(statuses.at(-1).at, 2_000);
  registry.remove(http);
  assert.equal(statuses.at(-1).online, false);
  const restarted = registry.add(entry("http"));
  assert.equal(registry.frame(http), false);
  registry.remove(http);
  assert.equal(registry.current(restarted), true);
  time = 10_000;
  registry.sweep();
  assert.equal(registry.current(socket), false);
  assert.equal(registry.current(idle), true);
  assert.deepEqual(registry.active(), []);
  assert.deepEqual(statuses.map(({ cameraId, online }) => [cameraId, online]), [
    ["socket", true], ["http", true], ["http", true], ["http", false], ["socket", false],
  ]);
  time = 62_000;
  registry.sweep();
  assert.equal(registry.current(idle), false);
  assert.equal(registry.current(restarted), false);
  assert.equal(statuses.length, 5);
});

test("simulation, unspecified provenance and invalid frame envelopes fail admission", () => {
  for (const source of [undefined, null, "demo", "clip", "synthetic", "uploaded", "Live"]) {
    assert.equal(isLiveSource(source), false);
  }
  assert.equal(isLiveSource("live"), true);
  const envelope = Buffer.alloc(100);
  assert.equal(isJPEG(envelope), false);
  envelope.set([0xff, 0xd8], 0);
  envelope.set([0xff, 0xd9], 98);
  assert.equal(isJPEG(envelope), true);
  assert.equal(isJPEG(envelope.subarray(0, 99)), false);
});

test("authenticated capture uses its pinned mask and only the server can persist an exact detector frame", async () => {
  const source = readFileSync(join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf('app.post("/api/camera-events"');
  const end = source.indexOf('io.on("connection"', start);
  const relayStart = source.indexOf('function relayCameraEvent(');
  const relayEnd = source.indexOf('const isPlainObject', relayStart);
  assert.ok(start >= 0 && end > start && relayStart >= 0 && relayEnd > relayStart);
  const access = { airport: "KPCT", principal: "camera-account" };
  const deviceId = randomUUID(), session = randomUUID(), pose = {
    lat: 38, lon: -77, heading_deg: 90, hfov_deg: 60, pitch_deg: 0,
  };
  const cameraId = cameraIdentity(access, "http", deviceId);
  const approved = [[0, 0], [1, 0], [1, 1]];
  const routes = new Map(), cameraHandlers = new Map(), towerHandlers = new Map();
  const namespace = handlers => ({ on: (name, fn) => handlers.set(name, fn) });
  const messages = [], records = [];
  const jpeg = Buffer.alloc(100);
  jpeg.set([255, 216], 0);
  jpeg.set([255, 217], jpeg.length - 2);
  const broadcast = { emit: (name, data) => messages.push([name, data]), get volatile() { return this; } };
  let sendDetection, snapshot = jpeg.toString("base64");
  const context = {
    app: { post: (path, ...fns) => routes.set(path, fns.at(-1)) },
    express: { raw() {} }, bearerToken() {}, cameraAccess: async () => access,
    cameras: namespace(cameraHandlers), towers: namespace(towerHandlers), installSocketAccess() {},
    setInterval: () => ({ unref() {} }), createCameraRegistry, cameraIdentity, isDeviceId, isJPEG, isLiveSource,
    isPlainObject: value => value !== null && typeof value === "object" && !Array.isArray(value),
    towersFor: airport => { assert.equal(airport, "KPCT"); return broadcast; },
    towerRoom: airport => `airport:${airport}`, airports: new Set(["KPCT"]),
    surveyedCorridor, surveyedCorridors: [{ cameraId, airport: "KPCT", camera: pose, polygon: approved, surveyId: "survey" }],
    randomUUID, CameraBot: class {
      constructor({ onEvent }) { this.onEvent = onEvent; }
      configure() {}
      invalidate() {}
      status() { return { mode: "server" }; }
      freshState() { return this.state; }
      remainingMs() { return 1000; }
      async frame(_jpeg, t, frame) {
        this.state = { t, generation: "detector-generation" };
        const event = { type: "bird", risk: "red", snapshot, airport: "untrusted" };
        sendDetection = (candidate, state = this.state) => this.onEvent(event, candidate, state);
        sendDetection({ ...frame, t: String(t) });
        sendDetection({ ...frame, streamId: "retired-stream" });
        sendDetection(frame, { ...this.state, generation: "retired-generation" });
        sendDetection(frame);
      }
    },
    mongo: true, pendingReceipts: new Set(), retainIncidentEvidence: true, createIncidentJob, sanitizeMetrics,
    memIncidents: [], rememberDetection() {},
    buildAlertText: () => "Bird warning", shouldAlert: () => true, drainEnrichment() {},
    toText: x => typeof x === "string" ? x : null, toNumber: x => Number.isFinite(x) ? x : null,
    journal: createEventJournal(fn => fn({ collection: name => ({
      async insertOne(row, opts) {
        assert.equal(name, "detections");
        assert.equal(opts.writeConcern.w, "majority");
        records.push(row);
        return { acknowledged: true };
      },
    }) })),
    console: { log() {} },
  };
  const registry = runInNewContext(`${source.slice(relayStart, relayEnd)}\n${source.slice(start, end)}\nliveCameras;`, context);
  const headers = { "x-camera-source": "live", "x-camera-device": deviceId, "x-camera-session": session };
  async function post(name, body, overrides = {}) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await routes.get(name)({ body, get: name => ({ ...headers, ...overrides })[name] }, res);
    return res;
  }
  const config = { source: "live", camera: pose, corridor: [[0, 0], [0.2, 0], [0.2, 1]] };
  assert.equal((await post("/api/camera-config", { ...config, source: "preview" })).code, 400);
  assert.equal(registry.get(cameraId), undefined);
  assert.equal((await post("/api/camera-config", { ...config, camera: { ...pose, pitch_deg: 1 } })).code, 200);
  assert.equal(registry.get(cameraId).config.surveyId, undefined);
  assert.equal((await post("/api/camera-config", config)).code, 200);
  assert.equal(registry.get(cameraId).config.surveyId, "survey");
  assert.equal(registry.get(cameraId).config.corridor, approved);
  assert.equal((await post("/api/camera-stop", {}, { "x-camera-session": randomUUID() })).code, 200);
  assert.ok(registry.get(cameraId));
  assert.equal((await post("/api/camera-events", {})).code, 403);

  const handlers = new Map();
  cameraHandlers.get("connection")({ data: { grant: access, airport: "KPCT" }, handshake: { auth: { deviceId } },
    on: (name, fn) => handlers.set(name, fn) });
  handlers.get("camera:event")({}, reply => assert.equal(reply.ok, false));
  towerHandlers.get("connection")({ data: { airport: "KPCT" }, join() {}, on: (name, fn) => handlers.set(name, fn) });
  for (const name of ["tower:label", "tower:bot-event"]) handlers.get(name)({}, reply => assert.equal(reply.ok, false));
  assert.equal(records.length, 0);

  assert.equal((await post("/api/camera-frame", jpeg, { "x-frame-time": "8.125" })).code, 200);
  const [, frame] = messages.find(([name]) => name === "camera:frame");
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.airport, "KPCT");
  assert.equal(record.camera_id, cameraId);
  assert.equal(record.enrichment.incident.airport, "KPCT");
  assert.deepEqual({ ...record.enrichment.incident.detection }, {
    streamId: frame.streamId, frameId: frame.frameId, generation: "detector-generation", t: 8.125,
  });
  assert.equal(record.enrichment.evidence.bytes, jpeg.toString("base64"));
  const events = messages.filter(([name]) => name === "camera:event");
  assert.equal(events.length, 1);
  assert.equal(Object.hasOwn(events[0][1], "snapshot"), false);
  const pending = messages.find(([name]) => name === "incident")[1];
  assert.equal(pending.persistence, "pending");
  assert.equal(Object.hasOwn(pending, "revision"), false);
  await post("/api/camera-stop", {});
  sendDetection(frame);
  assert.equal(records.length, 1, "late detector callbacks after stop must not persist");

  snapshot = "x".repeat(800_000);
  assert.equal((await post("/api/camera-config", config)).code, 200);
  assert.equal((await post("/api/camera-frame", jpeg, { "x-frame-time": "8.625" })).code, 200);
  const invalid = records[1];
  assert.equal(invalid.enrichment.incident.snapshot_state, "invalid");
  assert.equal(invalid.enrichment.evidence, null);
  assert.equal(invalid.alert.risk, "red");
  assert.equal(messages.findLast(([name]) => name === "alert")[1].id, invalid._id);
  const invalidEvent = messages.findLast(([name]) => name === "camera:event")[1];
  assert.equal(invalidEvent.risk, "red");
  assert.equal(Object.hasOwn(invalidEvent, "snapshot"), false);
  await post("/api/camera-stop", {});

  context.mongo = null;
  assert.equal((await post("/api/camera-config", config)).code, 200);
  assert.equal((await post("/api/camera-frame", jpeg, { "x-frame-time": "9.125" })).code, 200);
  const preview = messages.findLast(([name]) => name === "incident")[1];
  assert.equal(preview.persistence, "unavailable");
  assert.equal(preview.report_state, "unavailable");
  assert.equal(Object.hasOwn(preview, "revision"), false, "memory-only alerts are not committed revisions");
  assert.equal(Object.hasOwn(preview, "snapshot"), false);
  assert.equal(context.memIncidents[0], preview);
  assert.equal(records.length, 2);
});

test("a server detector motion overflow clears a usable state and suppresses evidence and events", async () => {
  const source = readFileSync(join(__dirname, "..", "bot.js"), "utf8");
  const fakeImage = {
    resize() { return this; }, ensureAlpha() { return this; }, raw() { return this; },
    async toBuffer() { return { data: Buffer.alloc(4), info: { width: 1, height: 1 } }; },
  };
  const sandbox = { require: name => name === "sharp" ? () => fakeImage : require(name),
    module: {}, __dirname: join(__dirname, ".."), process: { env: {} }, console };
  runInNewContext(source, sandbox);
  const { CameraBot } = sandbox.module.exports;
  const states = [], events = [];
  let overflow = false;
  const bot = new CameraBot({ cameraId: "test", now: () => 100, onStatus() {},
    onState: state => states.push(state), onEvent: event => events.push(event) });
  bot.engine = { process(tinyImage, t) {
    if (overflow) bot.events.push({ risk: "red" });
    return { t, motion: { ready: true, overflow }, risk: { level: "green" }, tracks: [], flocks: [], stats: {} };
  } };
  bot.generation = "test-generation";
  await bot.frame(Buffer.alloc(100), 1, { t: 1 });
  assert.equal(bot.freshState().risk, "green");
  overflow = true;
  await bot.frame(Buffer.alloc(100), 2, { t: 2 });
  assert.equal(bot.freshState(), null);
  assert.equal(bot.status().mode, "starting");
  assert.equal(states.length, 1);
  assert.equal(events.length, 0);
});
