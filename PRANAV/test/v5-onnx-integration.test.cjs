"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { after, before, describe, test } = require("node:test");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { Worker } = require("node:worker_threads");

const express = require("express");
const sharp = require("sharp");

const {
  V5_ONNX_SHA256,
  V5_MAX_BYTES,
  DEFAULT_V5_ONNX_PATH,
  verifyOnnxFile,
  getLocalTiersMetadata,
  registerV5ModelRoutes,
} = require("../v5-model-route");

const {
  askOnnxV5IsBird,
  createOnnxV5Judge,
  closeDefaultOnnxV5Worker,
} = require("../ai-voice/onnx-v5-judge");

const PYTHON_BIN = process.env.PYTHON_BIN || process.env.PYTHON || "python";
const WORKER_PY_PATH = path.join(__dirname, "..", "ai-voice", "onnx_v5_worker.py");
const V5_CLIENT_URL = pathToFileURL(
  path.join(__dirname, "..", "public", "js", "skysentry-v5-client.mjs")
).href;
const V5_WORKER_URL = pathToFileURL(
  path.join(__dirname, "..", "public", "js", "skysentry-v5-worker.mjs")
).href;

// Scratch directory inside the workspace (never /tmp) cleaned up on suite teardown.
const FIXTURE_DIR = path.join(__dirname, `.v5-onnx-test-fixtures-${process.pid}`);

let realOnnxBuffer;
let tamperedOnnxPath;
let emptyOnnxPath;
let oversizedOnnxPath;
let missingOnnxPath;

before(() => {
  realOnnxBuffer = fs.readFileSync(DEFAULT_V5_ONNX_PATH);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  tamperedOnnxPath = path.join(FIXTURE_DIR, "tampered.onnx");
  const copy = Buffer.from(realOnnxBuffer);
  copy[copy.length - 1] ^= 0xff;
  fs.writeFileSync(tamperedOnnxPath, copy);

  emptyOnnxPath = path.join(FIXTURE_DIR, "empty.onnx");
  fs.writeFileSync(emptyOnnxPath, Buffer.alloc(0));

  oversizedOnnxPath = path.join(FIXTURE_DIR, "oversized.onnx");
  const fd = fs.openSync(oversizedOnnxPath, "w");
  try {
    fs.ftruncateSync(fd, V5_MAX_BYTES + 1);
  } finally {
    fs.closeSync(fd);
  }

  missingOnnxPath = path.join(FIXTURE_DIR, "does-not-exist.onnx");
});

after(() => {
  closeDefaultOnnxV5Worker();
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

async function startExpressServer(t, options = {}) {
  const app = express();
  registerV5ModelRoutes(app, { cache: new Map(), ...options });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function makeSyntheticJpegBase64({ width = 96, height = 96, seed = 1 } = {}) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 3) {
      rgb[i] = (x * 5 + seed * 31) & 0xff;
      rgb[i + 1] = (y * 7 + seed * 17) & 0xff;
      rgb[i + 2] = ((x ^ y) * 3 + seed * 53) & 0xff;
    }
  }
  const jpeg = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  return jpeg.toString("base64");
}

function loadAiWithEnv(envOverrides = {}, customOnnxJudge = null) {
  const aiDir = path.join(__dirname, "..", "ai-voice");
  const modules = {
    path,
    "./describe": require("../ai-voice/describe"),
    "./bird-judge.spec.json": require("../ai-voice/bird-judge.spec.json"),
    "./onnx-v5-judge": customOnnxJudge || require("../ai-voice/onnx-v5-judge"),
  };

  function runModule(name) {
    const mod = { exports: {} };
    const code = fs.readFileSync(path.join(aiDir, `${name}.js`), "utf8");
    vm.runInNewContext(code, {
      module: mod,
      exports: mod.exports,
      __dirname: aiDir,
      fetch: async () => {
        throw new Error("Cloud fetch must never be called when BIRD_JUDGE=onnx");
      },
      AbortSignal,
      Date,
      Set,
      Object,
      Array,
      Number,
      String,
      Boolean,
      Math,
      JSON,
      Error,
      RegExp,
      Promise,
      console: { warn() {} },
      process: {
        env: {
          NODE_ENV: "production",
          BIRD_JUDGE: "onnx",
          ...envOverrides,
        },
      },
      require(id) {
        if (Object.hasOwn(modules, id)) return modules[id];
        throw new Error(`Unexpected require("${id}") in isolated ai.js test`);
      },
    });
    return mod.exports;
  }

  modules["./config"] = runModule("config");
  modules["./bird-judge"] = runModule("bird-judge");
  return {
    config: modules["./config"],
    birdJudge: modules["./bird-judge"],
    ai: runModule("ai"),
  };
}

// ============================================================================
// 1. v5-model-route.js
// ============================================================================

describe("v5-model-route.js (/ai-models/skysentry_v5.onnx and /api/models/local-tiers)", () => {
  test("serves verified v5 ONNX artifact with immutable caching, HEAD, and ETag 304", async (t) => {
    const baseUrl = await startExpressServer(t);
    const modelUrl = `${baseUrl}/ai-models/skysentry_v5.onnx`;
    const expectedEtag = `"sha256-${V5_ONNX_SHA256}"`;

    const getRes = await fetch(modelUrl);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get("content-type"), "application/octet-stream");
    assert.equal(getRes.headers.get("content-length"), String(realOnnxBuffer.length));
    assert.equal(getRes.headers.get("etag"), expectedEtag);
    assert.equal(getRes.headers.get("x-model-sha256"), V5_ONNX_SHA256);
    assert.equal(getRes.headers.get("x-content-type-options"), "nosniff");
    assert.match(getRes.headers.get("cache-control") || "", /immutable/);

    const downloaded = Buffer.from(await getRes.arrayBuffer());
    assert.equal(downloaded.length, realOnnxBuffer.length);
    const actualSha = crypto.createHash("sha256").update(downloaded).digest("hex");
    assert.equal(actualSha, V5_ONNX_SHA256);

    for (const inm of [expectedEtag, `W/${expectedEtag}`, `"other", ${expectedEtag}`, "*"]) {
      const notModified = await fetch(modelUrl, { headers: { "If-None-Match": inm } });
      assert.equal(notModified.status, 304);
      assert.equal((await notModified.arrayBuffer()).byteLength, 0);
      assert.equal(notModified.headers.get("etag"), expectedEtag);
    }

    const headRes = await fetch(modelUrl, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("content-length"), String(realOnnxBuffer.length));
    assert.equal(headRes.headers.get("etag"), expectedEtag);
    assert.equal(headRes.headers.get("x-model-sha256"), V5_ONNX_SHA256);
    assert.equal((await headRes.arrayBuffer()).byteLength, 0);
  });

  test("fails closed with 404/503 and no-store when v5 ONNX is missing, tampered, empty, or oversized", async (t) => {
    const cases = [
      [missingOnnxPath, 404, "missing"],
      [tamperedOnnxPath, 503, "sha256_mismatch"],
      [emptyOnnxPath, 503, "oversized"],
      [oversizedOnnxPath, 503, "oversized"],
    ];

    for (const [onnxPath, expectedStatus, expectedReason] of cases) {
      const check = await verifyOnnxFile(onnxPath, V5_ONNX_SHA256, new Map());
      assert.equal(check.ok, false);
      assert.equal(check.status, expectedStatus);
      assert.equal(check.reason, expectedReason);

      const baseUrl = await startExpressServer(t, { onnxPath });
      const res = await fetch(`${baseUrl}/ai-models/skysentry_v5.onnx`);
      assert.equal(res.status, expectedStatus);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const body = await res.json();
      assert.equal(body.reason, expectedReason);

      const tiersRes = await fetch(`${baseUrl}/api/models/local-tiers`);
      assert.equal(tiersRes.status, 200);
      assert.equal(tiersRes.headers.get("cache-control"), "no-store");
      const tiers = await tiersRes.json();
      const v5Tier = tiers.tiers.find((item) => item.id === "v5");
      assert.equal(v5Tier.available, false);
      assert.equal(v5Tier.bytes, null);
      assert.equal(v5Tier.reason, expectedReason);
    }
  });

  test("/api/models/local-tiers reports complete v4.1 and v5 metadata when valid", async (t) => {
    const baseUrl = await startExpressServer(t);
    const res = await fetch(`${baseUrl}/api/models/local-tiers`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const meta = await res.json();
    assert.deepEqual(meta, await getLocalTiersMetadata({ cache: new Map() }));
    assert.equal(meta.defaultTier, "v4.1");

    const v41 = meta.tiers.find((tier) => tier.id === "v4.1");
    const v5 = meta.tiers.find((tier) => tier.id === "v5");
    assert.ok(v41 && v5);
    assert.equal(v41.default, true);
    assert.equal(v41.advisoryOnly, true);
    assert.equal(v5.available, true);
    assert.equal(v5.reason, null);
    assert.equal(v5.bytes, realOnnxBuffer.length);
    assert.equal(v5.sha256, V5_ONNX_SHA256);
    assert.equal(v5.inputSize, 96);
    assert.equal(v5.inputName, "crop96_normalised");
    assert.equal(v5.outputName, "logits");
    assert.deepEqual(v5.classes, ["bird", "drone", "other"]);
    assert.deepEqual(v5.normalization, {
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
    });
    assert.equal(v5.advisoryOnly, true);
  });
});

// ============================================================================
// 2. onnx_v5_worker.py + onnx-v5-judge.js + ai.js (BIRD_JUDGE=onnx)
// ============================================================================

describe("onnx-v5-judge.js + ai.js (BIRD_JUDGE=onnx) + onnx_v5_worker.py", () => {
  test("runs real end-to-end ONNX Runtime inference via persistent worker and sharp", async (t) => {
    const judge = createOnnxV5Judge();
    t.after(() => judge.close());

    const b64A = await makeSyntheticJpegBase64({ width: 96, height: 96, seed: 3 });
    const b64B = await makeSyntheticJpegBase64({ width: 160, height: 120, seed: 19 });

    const verdictA = await judge.askOnnxV5IsBird(b64A, "bird, 1 object(s)");
    const verdictB = await judge.askOnnxV5IsBird(`data:image/jpeg;base64,${b64B}`, "unknown");

    for (const v of [verdictA, verdictB]) {
      assert.equal(v.status, "verified");
      assert.equal(v.source, "local");
      assert.equal(v.model, "skysentry-v5-onnx");
      assert.ok(["bird", "not_bird", "uncertain"].includes(v.verdict));
      assert.ok(Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 1);
      assert.match(v.evidence, /^Local AI Model v5 ONNX: bird \d+\.\d%, drone \d+\.\d%, other \d+\.\d%\.$/);
    }

    // Default singleton export also runs and shuts down cleanly.
    const singletonVerdict = await askOnnxV5IsBird(b64A);
    assert.equal(singletonVerdict.verdict, verdictA.verdict);
    assert.equal(singletonVerdict.confidence, verdictA.confidence);
    closeDefaultOnnxV5Worker();
  });

  test("ai.js with BIRD_JUDGE=onnx works offline without cloud policy or Gemini credentials", async (t) => {
    const judge = createOnnxV5Judge();
    t.after(() => judge.close());

    const { ai } = loadAiWithEnv({ GEMINI_CLOUD_EVIDENCE_ENABLED: "false" }, judge);
    const b64 = await makeSyntheticJpegBase64({ seed: 11 });
    const dataUrl = `data:image/jpeg;base64,${b64}`;

    const direct = await ai.verifyBird(dataUrl, "bird, 1 object(s)");
    assert.equal(direct.status, "verified");
    assert.equal(direct.source, "local");
    assert.equal(direct.model, "skysentry-v5-onnx");

    const missingImg = await ai.verifyBird("");
    assert.equal(missingImg.status, "unavailable");
    assert.equal(missingImg.reason, "no_image");

    const report = await ai.analyzeEvent({
      camera_id: "cam-north",
      type: "bird",
      object_count: 2,
      direction: "left to right",
      confidence: 0.84,
      risk: "yellow",
      snapshot: dataUrl,
    });
    assert.equal(report.source, "fallback");
    assert.equal(report.bird_verdict.status, "verified");
    assert.equal(report.bird_verdict.model, "skysentry-v5-onnx");
  });

  test("tampered ONNX weights fail closed with onnx_tampered in worker, judge, and ai.js", async () => {
    // 1. Direct Python worker verification check
    const py = spawnSync(
      PYTHON_BIN,
      [WORKER_PY_PATH, "--model", tamperedOnnxPath],
      {
        input: JSON.stringify({ id: 7, type: "ping" }) + "\n",
        encoding: "utf8",
      }
    );
    assert.notEqual(py.status, 0);
    const pyMsg = JSON.parse(py.stdout.trim());
    assert.equal(pyMsg.id, 7);
    assert.equal(pyMsg.ok, false);
    assert.equal(pyMsg.reason, "onnx_tampered");

    // 2. Node judge check
    const b64 = await makeSyntheticJpegBase64({ seed: 5 });
    const judge = createOnnxV5Judge({ cache: new Map() });
    try {
      await assert.rejects(
        judge.askOnnxV5IsBird(b64, "", { onnxPath: tamperedOnnxPath }),
        { reason: "onnx_tampered" }
      );
    } finally {
      judge.close();
    }

    // 3. ai.js mapping check
    const { ai } = loadAiWithEnv({ ONNX_V5_MODEL_PATH: tamperedOnnxPath });
    const unavailable = await ai.verifyBird(b64);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.verdict, null);
    assert.equal(unavailable.isBird, null);
    assert.equal(unavailable.reason, "onnx_tampered");
  });

  test("handles probability mapping, confidence floor, invalid replies, and worker timeouts cleanly", async (t) => {
    const b64 = await makeSyntheticJpegBase64({ seed: 9 });

    function makeFakeSpawn(replyBuilder, delayMs = 0) {
      return () => {
        const { PassThrough } = require("node:stream");
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const listeners = new Map();
        let killed = false;

        stdin.on("data", (chunk) => {
          for (const line of String(chunk).split("\n")) {
            if (!line.trim() || killed) continue;
            const req = JSON.parse(line);
            const emitReply = () => {
              if (killed) return;
              const out = replyBuilder(req);
              if (out !== null) stdout.write(out + "\n");
            };
            if (delayMs > 0) setTimeout(emitReply, delayMs).unref();
            else setImmediate(emitReply);
          }
        });

        return {
          stdin,
          stdout,
          stderr,
          on(ev, fn) {
            listeners.set(ev, fn);
          },
          removeAllListeners() {
            listeners.clear();
          },
          kill() {
            killed = true;
          },
          ref() {},
          unref() {},
        };
      };
    }

    // Confident bird
    {
      const judge = createOnnxV5Judge({
        spawnImpl: makeFakeSpawn(({ id }) =>
          JSON.stringify({ id, ok: true, probs: { bird: 0.88, drone: 0.07, other: 0.05 } })
        ),
      });
      t.after(() => judge.close());
      const v = await judge.askOnnxV5IsBird(b64);
      assert.equal(v.verdict, "bird");
      assert.equal(v.isBird, true);
      assert.equal(v.object, "bird");
      assert.equal(v.confidence, 0.88);
    }

    // Confident drone -> not_bird with confidence = 1 - p_bird
    {
      const judge = createOnnxV5Judge({
        spawnImpl: makeFakeSpawn(({ id }) =>
          JSON.stringify({ id, ok: true, probs: { bird: 0.06, drone: 0.9, other: 0.04 } })
        ),
      });
      t.after(() => judge.close());
      const v = await judge.askOnnxV5IsBird(b64);
      assert.equal(v.verdict, "not_bird");
      assert.equal(v.isBird, false);
      assert.equal(v.object, "drone");
      assert.ok(Math.abs(v.confidence - 0.94) < 1e-9);
    }

    // Low-confidence split -> uncertain via BIRD_CONFIDENCE_FLOOR (0.7)
    {
      const judge = createOnnxV5Judge({
        spawnImpl: makeFakeSpawn(({ id }) =>
          JSON.stringify({ id, ok: true, probs: { bird: 0.52, drone: 0.28, other: 0.2 } })
        ),
      });
      t.after(() => judge.close());
      const v = await judge.askOnnxV5IsBird(b64);
      assert.equal(v.verdict, "uncertain");
      assert.equal(v.isBird, null);
      assert.equal(v.status, "verified");
    }

    // Malformed worker probabilities -> invalid_response -> local_invalid in ai.js
    {
      const judge = createOnnxV5Judge({
        spawnImpl: makeFakeSpawn(({ id }) =>
          JSON.stringify({ id, ok: true, probs: { bird: 2.0, drone: 0, other: 0 } })
        ),
      });
      t.after(() => judge.close());
      await assert.rejects(judge.askOnnxV5IsBird(b64), { reason: "invalid_response" });

      const { ai } = loadAiWithEnv({}, judge);
      const res = await ai.verifyBird(b64);
      assert.equal(res.status, "unavailable");
      assert.equal(res.reason, "local_invalid");
    }

    // Hung worker -> TimeoutError -> onnx_timeout in ai.js
    {
      const judge = createOnnxV5Judge({
        timeoutMs: 40,
        spawnImpl: makeFakeSpawn(() => null, 5_000),
      });
      t.after(() => judge.close());
      await assert.rejects(judge.askOnnxV5IsBird(b64, "", { timeoutMs: 40 }), {
        name: "TimeoutError",
        reason: "onnx_timeout",
      });

      const { ai } = loadAiWithEnv({}, {
        askOnnxV5IsBird: (img, ctx, opts) =>
          judge.askOnnxV5IsBird(img, ctx, { ...opts, timeoutMs: 40 }),
      });
      const res = await ai.verifyBird(b64);
      assert.equal(res.status, "unavailable");
      assert.equal(res.reason, "onnx_timeout");
    }
  });

  test("idle persistent Python worker unrefs handles so Node exits without explicit close()", async () => {
    const b64 = await makeSyntheticJpegBase64({ width: 48, height: 48, seed: 21 });
    const judgePath = path.join(__dirname, "..", "ai-voice", "onnx-v5-judge.js");
    const script = [
      `const { askOnnxV5IsBird } = require(${JSON.stringify(judgePath)});`,
      `(async () => {`,
      `  const v = await askOnnxV5IsBird(${JSON.stringify(b64)});`,
      `  if (v.status !== "verified") process.exit(2);`,
      `})();`,
    ].join("\n");

    const started = Date.now();
    const sub = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 8_000,
      env: process.env,
    });
    assert.equal(sub.error, undefined);
    assert.equal(sub.status, 0, sub.stderr);
    assert.ok(Date.now() - started < 8_000);
  });
});

// ============================================================================
// 3. skysentry-v5-client.mjs + skysentry-v5-worker.mjs + ONNX Runtime parity
// ============================================================================

function startV5WorkerThread(t, responses) {
  function bootstrap() {
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const { parentPort, workerData } = require("node:worker_threads");

    globalThis.self = {
      addEventListener(event, handler) {
        assert.equal(event, "message");
        parentPort.on("message", (data) => handler({ data }));
      },
      postMessage(reply) {
        parentPort.postMessage(reply);
      },
    };

    let fetchCount = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/ai-models/skysentry_v5.onnx");
      assert.equal(options?.mode, "same-origin");
      const mode = workerData.responses[fetchCount++];
      if (mode === "missing") return new Response("", { status: 404 });
      if (mode === "empty") return new Response(new Uint8Array(0), { status: 200 });
      if (mode === "oversized") {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new ArrayBuffer(workerData.maxBytes + 1);
          },
        };
      }
      if (mode === "tampered") {
        const bytes = new Uint8Array(fs.readFileSync(workerData.onnxPath));
        bytes[bytes.length - 1] ^= 0x01;
        return new Response(bytes, { status: 200 });
      }
      assert.equal(mode, "valid", `Unexpected fetch mode: ${mode}`);
      return new Response(fs.readFileSync(workerData.onnxPath), { status: 200 });
    };

    import(workerData.workerUrl)
      .then(() => {
        assert.equal(fetchCount, 0, "v5 worker must not fetch ONNX weights before load/classify");
        parentPort.postMessage("ready");
      })
      .catch((err) => {
        throw err;
      });
  }

  return (async () => {
    const worker = new Worker(`(${bootstrap.toString()})()`, {
      eval: true,
      workerData: {
        workerUrl: V5_WORKER_URL,
        onnxPath: DEFAULT_V5_ONNX_PATH,
        maxBytes: V5_MAX_BYTES,
        responses,
      },
    });
    t.after(() => worker.terminate());
    assert.deepEqual(await once(worker, "message"), ["ready"]);
    return worker;
  })();
}

function wrapNodeWorkerAsWebWorker(nodeWorker) {
  const wrapper = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg, transfer) {
      nodeWorker.postMessage(msg, transfer);
    },
    terminate() {
      nodeWorker.terminate();
    },
  };
  nodeWorker.on("message", (data) => wrapper.onmessage?.({ data }));
  nodeWorker.on("error", (err) => wrapper.onerror?.({ message: err.message }));
  nodeWorker.on("messageerror", () => wrapper.onmessageerror?.());
  return wrapper;
}

describe("skysentry-v5-client.mjs + skysentry-v5-worker.mjs & Python onnxruntime parity", () => {
  test("pure-JS ONNX executor matches Python onnxruntime logits within < 1e-4 on real best.onnx", async () => {
    const { createPureJsOnnxRunner, cropAndNormalize96 } = await import(V5_WORKER_URL);
    const runner = createPureJsOnnxRunner(realOnnxBuffer);

    // Build 3 distinct test tensors: 2 analytical float32 tensors + 1 cropped RGBA frame tensor
    const tensorA = new Float32Array(3 * 96 * 96);
    const tensorB = new Float32Array(3 * 96 * 96);
    for (let i = 0; i < tensorA.length; i++) {
      tensorA[i] = Math.sin(i * 0.019) * 1.4 + Math.cos(i * 0.0043) * 0.6;
      tensorB[i] = ((i * 2654435761) >>> 0) / 4294967295 * 4.0 - 2.0;
    }

    const width = 128;
    const height = 96;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p += 4) {
        rgba[p] = (x * 3 + y * 2) & 0xff;
        rgba[p + 1] = (180 - y + x) & 0xff;
        rgba[p + 2] = ((x * y) % 251) & 0xff;
        rgba[p + 3] = 255;
      }
    }
    const tensorC = cropAndNormalize96(
      { data: rgba, width, height },
      { x: 0.18, y: 0.22, w: 0.35, h: 0.4 }
    ).slice();

    const samples = [tensorA, tensorB, tensorC];
    const pyInput =
      samples
        .map((t, idx) =>
          JSON.stringify({
            id: idx,
            tensor_b64: Buffer.from(t.buffer, t.byteOffset, t.byteLength).toString("base64"),
            include_logits: true,
          })
        )
        .join("\n") + "\n";

    const py = spawnSync(PYTHON_BIN, [WORKER_PY_PATH], {
      input: pyInput,
      encoding: "utf8",
    });
    assert.equal(py.status, 0, py.stderr);
    const pyReplies = py.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(pyReplies.length, samples.length);

    for (let s = 0; s < samples.length; s++) {
      const jsLogits = runner.run(samples[s]);
      const pyLogits = pyReplies[s].logits;
      assert.equal(jsLogits.length, 3);
      assert.equal(pyLogits.length, 3);

      let maxLogitDiff = 0;
      for (let k = 0; k < 3; k++) {
        const diff = Math.abs(jsLogits[k] - pyLogits[k]);
        if (diff > maxLogitDiff) maxLogitDiff = diff;
      }
      assert.ok(
        maxLogitDiff < 1e-4,
        `Sample ${s} max abs logit diff ${maxLogitDiff} exceeded 1e-4 (JS=${[...jsLogits]} vs PY=${pyLogits})`
      );
    }
  });

  test("end-to-end Web Worker classify matches Python PIL crop + onnxruntime probabilities", async (t) => {
    const { createV5WorkerClient } = await import(V5_CLIENT_URL);
    const nodeWorker = await startV5WorkerThread(t, ["valid"]);
    const client = createV5WorkerClient({
      createWorker: () => wrapNodeWorkerAsWebWorker(nodeWorker),
      timeoutMs: 25_000,
    });
    t.after(() => client.close());

    await client.load();

    const width = 128;
    const height = 96;
    const rawRgb = Buffer.alloc(width * height * 3);
    const frameData = new Uint8ClampedArray(width * height * 4);
    for (let y = 0, p3 = 0, p4 = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p3 += 3, p4 += 4) {
        const r = (x * 2 + 15) & 0xff;
        const g = (y * 3 + 40) & 0xff;
        const b = ((x * 5 + y * 7) % 256) & 0xff;
        rawRgb[p3] = r;
        rawRgb[p3 + 1] = g;
        rawRgb[p3 + 2] = b;
        frameData[p4] = r;
        frameData[p4 + 1] = g;
        frameData[p4 + 2] = b;
        frameData[p4 + 3] = 255;
      }
    }

    const boxes = [
      { x: 0.1, y: 0.15, w: 0.25, h: 0.3 },
      { x: 0.65, y: 0.5, w: 0.3, h: 0.4 },
    ];

    const results = await client.classify({ data: frameData, width, height }, boxes);
    assert.equal(frameData.byteLength, 0, "owned RGBA ArrayBuffer should be transferred");
    assert.equal(results.length, 2);

    // Compute exact reference probabilities via Python crops.cut(..., 96) + onnxruntime
    const pyScript = [
      "import json, sys, numpy as np, onnxruntime as ort",
      "from PIL import Image",
      "payload = json.loads(sys.stdin.read())",
      "sys.path.insert(0, payload['model_dir'])",
      "from crops import cut, square_for_box",
      "rgb = np.frombuffer(bytes.fromhex(payload['rgb_hex']), dtype=np.uint8).reshape(payload['h'], payload['w'], 3)",
      "img = Image.fromarray(rgb)",
      "sess = ort.InferenceSession(payload['onnx'], providers=['CPUExecutionProvider'])",
      "mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)",
      "std = np.array([0.229, 0.224, 0.225], dtype=np.float32)",
      "out = []",
      "for b in payload['boxes']:",
      "    cx = (b['x'] + b['w'] / 2) * payload['w']",
      "    cy = (b['y'] + b['h'] / 2) * payload['h']",
      "    _, _, side = square_for_box(cx, cy, b['w'] * payload['w'], b['h'] * payload['h'])",
      "    crop = cut(img, cx, cy, side, 96).astype(np.float32) / np.float32(255.0)",
      "    x = np.ascontiguousarray(((crop - mean) / std).transpose(2, 0, 1)[None, ...], dtype=np.float32)",
      "    z = sess.run(['logits'], {'crop96_normalised': x})[0][0].astype(np.float64)",
      "    e = np.exp(z - np.max(z))",
      "    p = e / np.sum(e)",
      "    out.append({'bird': float(p[0]), 'drone': float(p[1]), 'other': float(p[2])})",
      "print(json.dumps(out))",
    ].join("\n");

    const pyRef = spawnSync(PYTHON_BIN, ["-c", pyScript], {
      input: JSON.stringify({
        w: width,
        h: height,
        rgb_hex: rawRgb.toString("hex"),
        onnx: DEFAULT_V5_ONNX_PATH,
        model_dir: path.resolve(__dirname, "..", "..", "Shreyansh Local Ai Model"),
        boxes,
      }),
      encoding: "utf8",
    });
    assert.equal(pyRef.status, 0, pyRef.stderr);
    const expectedProbs = JSON.parse(pyRef.stdout.trim());

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      assert.equal(r.model, "v5");
      assert.ok(["bird", "drone", "other"].includes(r.label));
      assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
      assert.equal(r.score, r.probs[r.label]);
      for (const cls of ["bird", "drone", "other"]) {
        assert.ok(
          Math.abs(r.probs[cls] - expectedProbs[i][cls]) < 1e-4,
          `Box ${i} class ${cls} probability mismatch: ${r.probs[cls]} vs ${expectedProbs[i][cls]}`
        );
      }
    }
  });

  test("rejects missing, empty, oversized, and SHA-256-tampered ONNX responses and recovers on retry", async (t) => {
    const worker = await startV5WorkerThread(t, [
      "missing",
      "empty",
      "oversized",
      "tampered",
      "valid",
    ]);

    const send = async (msg) => {
      const reply = once(worker, "message");
      worker.postMessage(msg);
      return (await reply)[0];
    };

    for (const [id, pattern] of [
      [1, /HTTP 404/],
      [2, /Empty v5 ONNX/],
      [3, /exceeds 20 MB/],
      [4, /SHA-256 verification failed/],
    ]) {
      const reply = await send({ id, type: "load" });
      assert.equal(reply.id, id);
      assert.equal(reply.ok, false);
      assert.match(reply.error, pattern);
    }

    assert.deepEqual(await send({ id: 5, type: "load" }), { id: 5, ok: true });
  });

  test("validates frames, boxes, client lifecycle, close, timeout, and optional globalThis.ort path", async (t) => {
    const { createV5WorkerClient } = await import(V5_CLIENT_URL);
    const { createV5ClassifierFromBuffer } = await import(V5_WORKER_URL);

    assert.throws(() => createV5WorkerClient({ timeoutMs: 0 }), RangeError);
    assert.throws(() => createV5WorkerClient({ createWorker: "bad" }), TypeError);

    // Verify optional preloaded globalThis.ort.InferenceSession hook
    const savedOrt = globalThis.ort;
    try {
      let ortCalls = 0;
      globalThis.ort = {
        Tensor: class FakeTensor {
          constructor(type, data, dims) {
            this.type = type;
            this.data = data;
            this.dims = dims;
          }
        },
        InferenceSession: {
          async create() {
            return {
              async run(feeds) {
                ortCalls++;
                assert.equal(feeds.crop96_normalised.dims.join(","), "1,3,96,96");
                return { logits: { data: new Float32Array([-1.0, 2.5, 0.2]) } };
              },
            };
          },
        },
      };
      const ortClf = await createV5ClassifierFromBuffer(new ArrayBuffer(16), { preferOrt: true });
      const ortOut = await ortClf.classifyBoxes(
        { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) },
        [{ x: 0, y: 0, w: 1, h: 1 }]
      );
      assert.equal(ortCalls, 1);
      assert.equal(ortOut[0].label, "drone");
      assert.equal(ortOut[0].model, "v5");
    } finally {
      if (savedOrt === undefined) delete globalThis.ort;
      else globalThis.ort = savedOrt;
    }

    // Worker-side input validation before loading assets
    const rawWorker = await startV5WorkerThread(t, []);
    const sendRaw = async (msg) => {
      const reply = once(rawWorker, "message");
      rawWorker.postMessage(msg);
      return (await reply)[0];
    };
    const validFrame = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    const validBox = { x: 0, y: 0, w: 0.5, h: 0.5 };
    for (const [req, pattern] of [
      [{ id: null, type: "load" }, /request id/],
      [{ id: 1, type: "unknown" }, /Unknown request type/],
      [{ id: 2, type: "classify", frame: { ...validFrame, width: 0 }, boxes: [validBox] }, /dimensions/],
      [{ id: 3, type: "classify", frame: { width: 8_000_001, height: 1, data: new Uint8ClampedArray(4) }, boxes: [validBox] }, /8 megapixels/],
      [{ id: 4, type: "classify", frame: { width: 4, height: 4, data: new Uint8ClampedArray(60) }, boxes: [validBox] }, /RGBA bytes/],
      [{ id: 5, type: "classify", frame: validFrame, boxes: Array(9).fill(validBox) }, /up to 8 boxes/],
      [{ id: 6, type: "classify", frame: validFrame, boxes: [{ x: -0.1, y: 0, w: 0.5, h: 0.5 }] }, /normalized box/],
      [{ id: 7, type: "classify", frame: validFrame, boxes: [{ x: 0, y: 0, w: 0, h: 0.5 }] }, /normalized box/],
      [{ id: 8, type: "classify", frame: { width: 4097, height: 1, data: new Uint8ClampedArray(4097 * 4) }, boxes: [{ x: 0, y: 0, w: 1, h: 1 }] }, /Box exceeds 4096/],
    ]) {
      const rep = await sendRaw(req);
      assert.equal(rep.ok, false);
      assert.match(rep.error, pattern);
    }

    // Client lifecycle: non-owned view rejection, close(), and timeout
    class MockWorker {
      messages = [];
      terminated = 0;
      postMessage(msg, transfer) {
        this.messages.push(structuredClone(msg, { transfer }));
      }
      terminate() {
        this.terminated++;
      }
      reply(payload) {
        this.onmessage?.({ data: { id: this.messages.at(-1).id, ...payload } });
      }
    }

    const mocks = [];
    const client = createV5WorkerClient({
      createWorker() {
        const w = new MockWorker();
        mocks.push(w);
        return w;
      },
      timeoutMs: 30,
    });
    t.after(() => client.close());

    await assert.rejects(
      client.classify({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [validBox]),
      /not loaded/
    );

    const loadP = client.load();
    mocks[0].reply({ ok: true });
    await loadP;

    const backing = new Uint8ClampedArray(8);
    await assert.rejects(
      client.classify({ width: 1, height: 1, data: backing.subarray(0, 4) }, [validBox]),
      /owned RGBA/
    );
    assert.equal(backing.byteLength, 8);

    // Timeout transitions worker to stopped and requires explicit reload
    await assert.rejects(
      client.classify({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, [validBox]),
      { name: "TimeoutError" }
    );
    assert.equal(mocks[0].terminated, 1);

    // Explicit close during reload rejects with AbortError
    const reloadP = client.load();
    const abortCheck = assert.rejects(reloadP, { name: "AbortError" });
    client.close();
    await abortCheck;
    assert.equal(mocks[1].terminated, 1);
  });
});
