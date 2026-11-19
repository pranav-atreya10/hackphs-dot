const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBirdReview } = require("../bird-review");

function fixture(verify = async () => ({ status: "verified", source: "gemini", verdict: "not_bird" })) {
  let now = 100;
  const bbox = { x: .2, y: .2, w: .1, h: .1 }, state = { t: .1, generation: "detector-a", tracks: [{ id: 2, bbox }] };
  const live = { airport: "A", streamId: "stream", bot: { active: true }, lastState: state };
  const ref = { cameraId: "cam", streamId: live.streamId, frameId: 1, trackId: 2 };
  const evidence = Buffer.from("synthetic evidence"), crops = [];
  const service = createBirdReview({
    clock: () => now, findLive: (id) => id === "cam" ? live : null, verify,
    crop: async (bytes, box) => { crops.push({ bytes, box }); return "crop"; },
  });
  service.record(live, { ...ref, jpeg: evidence, at: now, t: state.t }, state);
  return { live, ref, evidence, bbox, crops, service, expire: () => { now += 2501; } };
}

test("review resolves the exact airport, camera, stream, frame, and track from server evidence", async () => {
  const f = fixture();
  for (const [ref, airport] of [[f.ref, "B"], [{ ...f.ref, streamId: "old" }, "A"], [{ ...f.ref, frameId: 2 }, "A"], [{ ...f.ref, trackId: 3 }, "A"]]) {
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
  assert.equal(result.crop, "crop");          // kept for the opt-in training set; the route strips it before replying
});
