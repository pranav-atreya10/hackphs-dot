const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const { createBirdReview } = require("../bird-review");

const PIXELS = Buffer.from("synthetic crop").toString("base64");
const CROP = `data:image/jpeg;base64,${PIXELS}`;

function evidenceFixture() {
  let now = 100;
  const bbox = { x: .2, y: .2, w: .1, h: .1 };
  const state = { t: .1, generation: "detector-a", risk: "red", tracks: [{ id: 2, bbox }] };
  const live = { airport: "A", streamId: "stream", bot: { active: true }, lastState: state };
  const ref = { cameraId: "cam", streamId: live.streamId, frameId: 1, trackId: 2 };
  const evidence = Buffer.from("synthetic evidence"), crops = [];
  return {
    live, ref, evidence, bbox, crops,
    clock: () => now,
    expire: () => { now += 2501; },
    findLive: id => id === ref.cameraId ? live : null,
    crop: async (bytes, box) => { crops.push({ bytes, box }); return CROP; },
    record: service => service.record(live, { ...ref, jpeg: evidence, at: now, t: state.t }, state),
  };
}

function fixture(verify = async () => ({ status: "verified", source: "gemini", verdict: "not_bird" })) {
  const f = evidenceFixture();
  const { clock, findLive, crop } = f;
  const service = createBirdReview({ clock, findLive, crop, verify });
  f.record(service);
  return { ...f, service };
}

test("review resolves the exact airport, camera, stream, frame, and track from server evidence", async () => {
  const f = fixture();
  for (const [ref, airport] of [
    [f.ref, "B"], [{ ...f.ref, cameraId: "unknown-camera" }, "A"], [{ ...f.ref, streamId: "old" }, "A"],
    [{ ...f.ref, frameId: 2 }, "A"], [{ ...f.ref, trackId: 3 }, "A"],
  ]) {
    assert.equal((await f.service.review(ref, airport)).status, "unavailable");
  }
  assert.equal(f.crops.length, 0);
  const result = await f.service.review({ ...f.ref, verdict: "bird" }, "A");
  assert.equal(result.verdict, "not_bird");
  assert.deepEqual(result.evidenceRef, { ...f.ref, airport: "A", t: .1, generation: "detector-a" });
  assert.equal(result.application, "advisory");
  assert.deepEqual(f.crops, [{ bytes: f.evidence, box: f.bbox }]);
  assert.deepEqual(f.live.lastState.tracks, [{ id: 2, bbox: f.bbox }]);
});

for (const [label, change] of [
  ["the reference expires", (f) => f.expire()],
  ["the camera stream changes", (f) => { f.live.streamId = "new"; }],
  ["the detector generation changes", (f) => { f.live.lastState = { ...f.live.lastState, generation: "detector-b" }; }],
  ["the track disappears", (f) => { f.live.lastState = { tracks: [] }; }],
]) {
  test(`an in-flight result becomes historical when ${label}`, async () => {
    let finish;
    const result = new Promise((resolve) => { finish = resolve; });
    const f = fixture(() => result);
    const pending = f.service.review(f.ref, "A");
    assert.equal((await f.service.review(f.ref, "A")).reason, "busy");
    change(f);
    finish({ status: "verified", source: "gemini", verdict: "uncertain" });
    assert.equal((await pending).application, "historical");
  });
}

test("provider unavailability cannot become a verdict", async () => {
  const f = fixture(async () => ({ status: "unavailable", source: "fallback", reason: "timeout" }));
  assert.deepEqual(await f.service.review(f.ref, "A"), { status: "unavailable", reason: "timeout" });
});

test("review reads the live camera's state where server.js keeps it (live.lastResult.state), and accepts a local judge", async () => {
  const f = fixture(async () => ({ status: "verified", source: "local", verdict: "bird", model: "qwen2.5vl:7b" }));
  const state = f.live.lastState;
  delete f.live.lastState;
  f.live.lastResult = { frame: {}, state };   // the shape server.js actually stores
  const result = await f.service.review(f.ref, "A");
  assert.equal(result.status, "verified");
  assert.equal(result.source, "local");
  assert.equal(result.crop, CROP); // the route strips it before replying
});

const LOCAL_URL = "http://127.0.0.1:11493/v1";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent";

function loadJudge(env) {
  const calls = [];
  const answer = JSON.stringify({ verdict: "not_bird", confidence: .98, object: "fixture", evidence: "synthetic" });
  const fetch = async (url, { method, body } = {}) => {
    calls.push({ url, method, body });
    if (url === GEMINI_URL) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] }) };
    if (url === `${LOCAL_URL}/chat/completions`) return { ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) };
    throw new Error(`unexpected provider destination: ${url}`);
  };
  const judgeDir = join(__dirname, "..", "ai-voice");
  const modules = {
    path: require("node:path"),
    "./describe": require("../ai-voice/describe"),
    "./bird-judge.spec.json": require("../ai-voice/bird-judge.spec.json"),
  };
  function load(name) {
    const module = { exports: {} };
    runInNewContext(readFileSync(join(judgeDir, `${name}.js`), "utf8"), {
      module, __dirname: judgeDir, fetch, AbortSignal, console: { warn() {} },
      process: { env: { NODE_ENV: "production", GEMINI_API_KEY: "fixture-key", GEMINI_MODEL: "fixture-model", LOCAL_JUDGE_URL: LOCAL_URL, ...env } },
      require(id) {
        assert.ok(Object.hasOwn(modules, id), `unexpected judge dependency: ${id}`);
        return modules[id];
      },
    });
    return module.exports;
  }
  const config = modules["./config"] = load("config");
  modules["./bird-judge"] = load("bird-judge");
  return { config, ai: load("ai"), calls };
}

function routeFixture(env = {}) {
  const f = evidenceFixture();
  f.live.lastResult = { state: f.live.lastState };
  delete f.live.lastState;
  const { config, ai, calls } = loadJudge(env);
  const source = readFileSync(join(__dirname, "..", "server.js"), "utf8");
  const start = source.indexOf("const birdJudgeLimit");
  const end = source.indexOf('app.post("/api/camera-events"', start);
  assert.ok(start >= 0 && end > start, "expected the registered #61 bird-review routes");
  const routes = new Map(), audit = [];
  const requireDashboard = Symbol("requireDashboard"), requireAirport = Symbol("requireAirport");
  const capture = method => (path, dashboard, airport, handler) => {
    assert.equal(dashboard, requireDashboard);
    assert.equal(airport, requireAirport);
    assert.equal(typeof handler, "function");
    routes.set(`${method} ${path}`, handler);
  };
  const TOWER_API_KEY = "fixture-tower-key";
  const service = runInNewContext(`${source.slice(start, end)}\nbirdReview;`, {
    app: { get: capture("GET"), post: capture("POST") }, requireDashboard, requireAirport,
    aiConfig: config, ...ai, clerk: null, TOWER_API_KEY, keyMatches: (received, expected) => received === expected,
    createRequestLimit: () => () => true,
    createBirdReview: opts => createBirdReview({ ...opts, clock: f.clock }),
    liveCameras: { get: f.findLive, fresh: live => live === f.live },
    cropBirdReview: f.crop, logBirdVerdict: (...args) => audit.push(args),
    isPlainObject: value => value !== null && typeof value === "object" && !Array.isArray(value),
    console: { warn() {} },
  });
  f.record(service);
  async function request(route, { body, airport = f.live.airport, key = TOWER_API_KEY, provider } = {}) {
    const res = {
      code: 200,
      set() { return this; },
      status(code) { this.code = code; return this; },
      json(value) { this.body = structuredClone(value); },
    };
    const handler = routes.get(route);
    assert.equal(typeof handler, "function", `missing ${route}`);
    await handler({ body, airport, get: name => ({ "x-api-key": key, "x-bird-review-provider": provider })[name] }, res);
    return { code: res.code, body: res.body };
  }
  return {
    ...f, calls, audit, verifyBird: ai.verifyBird,
    policy: () => request("GET /api/cloud-evidence-policy"),
    post: (body = f.ref, scope) => request("POST /api/verify-bird", { body, ...scope }),
  };
}

test("the deployment flag is off by default even when the cloud judge has credentials", async () => {
  const f = routeFixture();
  const { body: policy } = await f.policy();
  assert.equal(policy.cloudEvidenceEnabled, false);
  assert.equal(policy.reviewEnabled, false);
  assert.deepEqual(await f.post(), { code: 200, body: { status: "unavailable", reason: "cloud_evidence_disabled" } });
  assert.equal((await f.verifyBird(CROP)).reason, "policy_disabled");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.crops, []);
  assert.deepEqual(f.audit, []);
});

for (const source of ["gemini", "local"]) {
  test(`the authenticated ${source} judge receives only the canonical server crop and stays advisory`, async () => {
    const f = routeFixture(source === "gemini" ? { GEMINI_CLOUD_EVIDENCE_ENABLED: "true" } : { BIRD_JUDGE: "local" });
    const { body: policy } = await f.policy();
    assert.equal(policy.birdJudge, source);
    assert.equal(policy.providerBinding, true);
    assert.equal(policy.cloudEvidenceEnabled, source === "gemini");
    assert.equal(policy.reviewEnabled, true);

    assert.equal((await f.post(f.ref, { key: null, provider: source })).code, 401);
    for (const extra of [{ image: CROP }, { generation: "detector-a" }, { t: .1 }, { airport: "A" }, { provider: source }]) {
      assert.deepEqual(await f.post({ ...f.ref, ...extra }, { provider: source }), {
        code: 400, body: { status: "unavailable", reason: "invalid_reference" },
      });
    }
    assert.deepEqual(await f.post(f.ref, { airport: "B", provider: source }), {
      code: 200, body: { status: "unavailable", reason: "unknown_evidence" },
    });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.crops, []);

    const before = structuredClone(f.live.lastResult.state);
    const { code, body } = await f.post(f.ref, { provider: source });
    assert.equal(code, 200);
    assert.equal(body.status, "verified");
    assert.equal(body.source, source);
    assert.equal(body.verdict, "not_bird");
    assert.equal(body.application, "advisory");
    assert.deepEqual(body.evidenceRef, { ...f.ref, airport: "A", generation: "detector-a", t: .1 });
    assert.doesNotMatch(JSON.stringify(body), new RegExp(PIXELS));
    assert.equal(Object.hasOwn(body, "crop"), false);
    assert.deepEqual(f.crops, [{ bytes: f.evidence, box: f.bbox }]);
    assert.deepEqual(f.calls.map(({ url, method }) => [url, method]), [[
      source === "local" ? `${LOCAL_URL}/chat/completions` : GEMINI_URL, "POST",
    ]]);
    const payload = JSON.parse(f.calls[0].body);
    if (source === "local") assert.equal(payload.messages[1].content[0].image_url.url, CROP);
    else assert.deepEqual(payload.contents[0].parts[0].inlineData, { mimeType: "image/jpeg", data: PIXELS });
    assert.equal(f.audit.length, 1);
    assert.equal(f.audit[0][1], "A");
    assert.deepEqual(f.live.lastResult.state, before);
  });
}

test("a stale local policy cannot authorize a Gemini crop after the server provider changes", async () => {
  const local = routeFixture({ BIRD_JUDGE: "local" });
  const { body: localPolicy } = await local.policy();
  assert.equal(localPolicy.birdJudge, "local");
  assert.equal((await local.post(local.ref, { provider: localPolicy.birdJudge })).body.status, "verified");
  const cloud = routeFixture({ GEMINI_CLOUD_EVIDENCE_ENABLED: "true" });
  const { body: cloudPolicy } = await cloud.policy();
  assert.equal(cloudPolicy.birdJudge, "gemini");
  assert.equal(cloudPolicy.reviewEnabled, true);
  for (const provider of [localPolicy.birdJudge, undefined, "off", "local, gemini"]) {
    assert.deepEqual(await cloud.post(cloud.ref, { provider }),
      { code: 409, body: { status: "unavailable", reason: "review_provider_mismatch" } });
  }
  assert.deepEqual(cloud.crops, []);
  assert.deepEqual(cloud.calls, []);
  assert.deepEqual(cloud.audit, []);
});

test("expired evidence and previous detector generations never reach the provider", async () => {
  const expired = routeFixture({ GEMINI_CLOUD_EVIDENCE_ENABLED: "true" });
  expired.expire();
  const retired = routeFixture({ GEMINI_CLOUD_EVIDENCE_ENABLED: "true" });
  retired.live.lastResult.state = { ...retired.live.lastResult.state, generation: "detector-b" };
  for (const f of [expired, retired]) {
    assert.deepEqual(await f.post(f.ref, { provider: "gemini" }), { code: 200, body: { status: "unavailable", reason: "unknown_evidence" } });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.crops, []);
    assert.deepEqual(f.audit, []);
  }
});
