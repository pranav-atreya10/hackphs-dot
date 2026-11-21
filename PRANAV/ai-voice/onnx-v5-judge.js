"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const {
  V5_ONNX_SHA256,
  DEFAULT_V5_ONNX_PATH,
  verifyOnnxFile,
} = require("../v5-model-route");
const { normalizeBirdVerdict } = require("./bird-judge");

const MODEL_ID = "skysentry-v5-onnx";
const CROP_SIZE = 96;
const RGB_BYTES = CROP_SIZE * CROP_SIZE * 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LINE_LENGTH = 1_048_576;
const MAX_INPUT_PIXELS = 16_777_216;
const DEFAULT_WORKER_SCRIPT = path.join(__dirname, "onnx_v5_worker.py");

let cachedSharp = null;
function loadSharp() {
  if (!cachedSharp) {
    cachedSharp = require("sharp");
    cachedSharp.cache?.(false);
    cachedSharp.concurrency?.(1);
  }
  return cachedSharp;
}

const activeChildren = new Set();
let exitHookRegistered = false;
function registerChildForExit(child) {
  activeChildren.add(child);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", () => {
      for (const proc of activeChildren) {
        try { proc.stdin?.end(); } catch {}
        try { proc.kill(); } catch {}
      }
      activeChildren.clear();
    });
  }
}

function stripDataUrl(image) {
  if (typeof image !== "string") return "";
  return image.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").trim();
}

function makeJudgeError(message, reason, name = "Error") {
  const err = new Error(message);
  err.name = name;
  err.reason = reason;
  return err;
}

function refWorkerHandles(state) {
  if (!state?.child) return;
  state.child.ref?.();
  state.child.stdin?.ref?.();
  state.child.stdout?.ref?.();
  state.child.stderr?.ref?.();
}

function unrefWorkerHandles(state) {
  if (!state?.child) return;
  state.child.unref?.();
  state.child.stdin?.unref?.();
  state.child.stdout?.unref?.();
  state.child.stderr?.unref?.();
}

function mapProbsToVerdict(probs) {
  if (!probs || typeof probs !== "object") {
    throw makeJudgeError("v5 ONNX worker reply omitted probs", "invalid_response");
  }
  const { bird, drone, other } = probs;
  if (
    ![bird, drone, other].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) ||
    Math.abs(bird + drone + other - 1) > 0.01
  ) {
    throw makeJudgeError("v5 ONNX worker returned invalid probabilities", "invalid_response");
  }

  const evidence =
    `Local AI Model v5 ONNX: bird ${(bird * 100).toFixed(1)}%, ` +
    `drone ${(drone * 100).toFixed(1)}%, other ${(other * 100).toFixed(1)}%.`;

  if (bird >= drone && bird >= other) {
    return normalizeBirdVerdict(
      {
        verdict: "bird",
        confidence: Math.min(1, Math.max(0, bird)),
        object: "bird",
        evidence,
      },
      MODEL_ID,
      "local"
    );
  }

  const notBirdConfidence = Math.min(1, Math.max(0, 1 - bird));
  const object = drone >= other ? "drone" : "non-bird object";
  return normalizeBirdVerdict(
    {
      verdict: "not_bird",
      confidence: notBirdConfidence,
      object,
      evidence,
    },
    MODEL_ID,
    "local"
  );
}

async function decodeAndResize96Rgb(image, sharpImpl) {
  const cleanB64 = stripDataUrl(image);
  if (!cleanB64 || !/^[A-Za-z0-9+/=\s]+$/.test(cleanB64)) {
    throw makeJudgeError("Invalid or empty base64 image for v5 ONNX judge", "onnx_failed");
  }
  const compact = cleanB64.replace(/\s+/g, "");
  if (compact.length % 4 === 1) {
    throw makeJudgeError("Malformed base64 image length for v5 ONNX judge", "onnx_failed");
  }
  const inputBuffer = Buffer.from(compact, "base64");
  if (inputBuffer.length === 0) {
    throw makeJudgeError("Decoded image buffer is empty", "onnx_failed");
  }

  const sharp = sharpImpl || loadSharp();
  let rgbBuffer;
  try {
    rgbBuffer = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .toColorspace("srgb")
      .removeAlpha()
      .resize(CROP_SIZE, CROP_SIZE, { fit: "fill", kernel: "linear" })
      .raw()
      .toBuffer();
  } catch (err) {
    throw makeJudgeError(`Failed to decode image for v5 ONNX judge: ${err.message}`, "onnx_failed");
  }

  if (!Buffer.isBuffer(rgbBuffer) || rgbBuffer.length !== RGB_BYTES) {
    throw makeJudgeError("Unexpected raw RGB byte length from sharp", "onnx_failed");
  }
  return rgbBuffer;
}

function createOnnxV5Judge(defaults = {}) {
  let workerState = null;
  let nextReqId = 0;

  function destroyWorker(state, rejectErr) {
    if (!state || state.closed) return;
    state.closed = true;
    if (workerState === state) workerState = null;

    const pendingEntries = [...state.pending.values()];
    state.pending.clear();
    for (const entry of pendingEntries) {
      clearTimeout(entry.timer);
      entry.reject(rejectErr || makeJudgeError("v5 ONNX worker closed", "onnx_failed"));
    }

    const child = state.child;
    if (child) {
      activeChildren.delete(child);
      child.removeAllListeners?.("error");
      child.removeAllListeners?.("exit");
      child.stdout?.removeAllListeners?.("data");
      child.stderr?.removeAllListeners?.("data");
      child.stdin?.removeAllListeners?.("error");
      try { child.stdin?.end(); } catch {}
      try { child.kill(); } catch {}
      unrefWorkerHandles(state);
    }
  }

  function ensureWorker({ onnxPath, expectedSha256, pythonBin, workerScriptPath, spawnImpl }) {
    const key = `${onnxPath}|${expectedSha256}|${pythonBin}|${workerScriptPath}`;
    if (workerState && !workerState.closed) {
      if (workerState.key === key && workerState.spawnImpl === spawnImpl) {
        return workerState;
      }
      destroyWorker(workerState, makeJudgeError("v5 ONNX worker reconfigured", "onnx_failed"));
    }

    const args = ["-u", workerScriptPath, "--model", onnxPath];
    if (expectedSha256 !== V5_ONNX_SHA256) {
      args.push("--expected-sha256", expectedSha256);
    }

    const child = spawnImpl(pythonBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    registerChildForExit(child);

    const state = {
      key,
      spawnImpl,
      child,
      closed: false,
      buffer: "",
      stderrTail: "",
      pending: new Map(),
    };

    const syncRefState = () => {
      if (state.closed) return;
      if (state.pending.size > 0) refWorkerHandles(state);
      else unrefWorkerHandles(state);
    };

    child.stdin?.on("error", () => {});

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => {
      state.stderrTail = (state.stderrTail + String(chunk)).slice(-512);
    });

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      if (state.closed) return;
      state.buffer += String(chunk);
      if (state.buffer.length > MAX_LINE_LENGTH) {
        destroyWorker(
          state,
          makeJudgeError("v5 ONNX worker output exceeded line limit", "invalid_response")
        );
        return;
      }

      let nlIndex;
      while ((nlIndex = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, nlIndex).trim();
        state.buffer = state.buffer.slice(nlIndex + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          destroyWorker(
            state,
            makeJudgeError("v5 ONNX worker emitted non-JSON output", "invalid_response")
          );
          return;
        }

        const entry = state.pending.get(msg?.id);
        if (!entry) continue;
        state.pending.delete(msg.id);
        clearTimeout(entry.timer);
        syncRefState();

        if (msg.ok === true) {
          entry.resolve(msg);
        } else {
          const reason =
            msg?.reason === "onnx_tampered"
              ? "onnx_tampered"
              : msg?.reason === "invalid_response"
                ? "invalid_response"
                : "onnx_failed";
          entry.reject(
            makeJudgeError(
              typeof msg?.error === "string" && msg.error
                ? msg.error
                : "v5 ONNX worker failed",
              reason
            )
          );
        }
      }
    });

    child.on("error", (err) => {
      destroyWorker(
        state,
        makeJudgeError(`Failed to spawn Python v5 ONNX worker: ${err.message}`, "onnx_failed")
      );
    });

    child.on("exit", (code, signal) => {
      const detail = state.stderrTail.trim();
      destroyWorker(
        state,
        makeJudgeError(
          `v5 ONNX worker exited unexpectedly (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`,
          "onnx_failed"
        )
      );
    });

    unrefWorkerHandles(state);
    workerState = state;
    return state;
  }

  async function askOnnxV5IsBird(image, _context = "", options = {}) {
    const startedAt = Date.now();
    const onnxPath = options.onnxPath || defaults.onnxPath || DEFAULT_V5_ONNX_PATH;
    const expectedSha256 = String(
      options.expectedSha256 || defaults.expectedSha256 || V5_ONNX_SHA256
    )
      .trim()
      .toLowerCase();
    const rawTimeout = options.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
    const pythonBin =
      options.pythonBin ||
      defaults.pythonBin ||
      process.env.PYTHON_BIN ||
      process.env.PYTHON ||
      "python";
    const workerScriptPath =
      options.workerScriptPath || defaults.workerScriptPath || DEFAULT_WORKER_SCRIPT;
    const spawnImpl = options.spawnImpl || defaults.spawnImpl || spawn;
    const sharpImpl = options.sharpImpl || defaults.sharpImpl || null;
    const cache = options.cache !== undefined ? options.cache : defaults.cache;

    const check = await verifyOnnxFile(onnxPath, expectedSha256, cache);
    if (!check.ok) {
      if (check.reason === "sha256_mismatch") {
        throw makeJudgeError(check.error || "v5 ONNX SHA-256 mismatch", "onnx_tampered");
      }
      throw makeJudgeError(check.error || "v5 ONNX model unavailable", "onnx_failed");
    }

    const rgbBuffer = await decodeAndResize96Rgb(image, sharpImpl);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw makeJudgeError(
        `v5 ONNX judge timed out after ${timeoutMs} ms`,
        "onnx_timeout",
        "TimeoutError"
      );
    }

    const state = ensureWorker({
      onnxPath: check.path,
      expectedSha256,
      pythonBin,
      workerScriptPath,
      spawnImpl,
    });

    const id = ++nextReqId;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        destroyWorker(
          state,
          makeJudgeError(
            `v5 ONNX worker timed out after ${timeoutMs} ms`,
            "onnx_timeout",
            "TimeoutError"
          )
        );
        reject(
          makeJudgeError(
            `v5 ONNX worker timed out after ${timeoutMs} ms`,
            "onnx_timeout",
            "TimeoutError"
          )
        );
      }, remainingMs);

      state.pending.set(id, { resolve, reject, timer });
      refWorkerHandles(state);

      try {
        state.child.stdin.write(
          JSON.stringify({ id, rgb_b64: rgbBuffer.toString("base64") }) + "\n"
        );
      } catch (err) {
        clearTimeout(timer);
        state.pending.delete(id);
        destroyWorker(
          state,
          makeJudgeError(`Failed writing to v5 ONNX worker: ${err.message}`, "onnx_failed")
        );
        reject(makeJudgeError(`Failed writing to v5 ONNX worker: ${err.message}`, "onnx_failed"));
      }
    });

    return mapProbsToVerdict(reply.probs);
  }

  function close() {
    if (workerState) {
      destroyWorker(workerState, makeJudgeError("v5 ONNX worker closed", "onnx_failed"));
    }
  }

  return { askOnnxV5IsBird, close };
}

let defaultJudge = null;

async function askOnnxV5IsBird(image, context = "", options = {}) {
  defaultJudge ??= createOnnxV5Judge();
  return defaultJudge.askOnnxV5IsBird(image, context, options);
}

function closeDefaultOnnxV5Worker() {
  if (defaultJudge) {
    defaultJudge.close();
    defaultJudge = null;
  }
}

module.exports = {
  V5_ONNX_SHA256,
  askOnnxV5IsBird,
  createOnnxV5Judge,
  closeDefaultOnnxV5Worker,
};
