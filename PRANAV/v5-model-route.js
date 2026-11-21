"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const V5_ONNX_SHA256 = "b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a";
const V5_MAX_BYTES = 20_000_000;
const V5_CACHE_SECONDS = 7 * 24 * 60 * 60;
const V5_IMMUTABLE_CACHE_CONTROL = `public, max-age=${V5_CACHE_SECONDS}, immutable`;

const DEFAULT_V5_ONNX_PATH = path.resolve(
  __dirname,
  "..",
  "Shreyansh Local Ai Model",
  "runs",
  "v5",
  "best.onnx"
);

const DEFAULT_V41_WEIGHTS_PATH = path.resolve(
  __dirname,
  "public",
  "ai-models",
  "skysentry_classifier.json"
);

const defaultCache = new Map();

function streamSha256(filePath, maxBytes = V5_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let bytesRead = 0;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    stream.on("data", (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        stream.destroy();
        const err = new Error("v5 ONNX model exceeds 20 MB safety cap");
        err.code = "OVERSIZED";
        finish(err);
        return;
      }
      hash.update(chunk);
    });

    stream.on("error", (err) => {
      finish(err);
    });

    stream.on("end", () => {
      finish(null, { digest: hash.digest("hex"), bytesRead });
    });
  });
}

async function verifyOnnxFile(
  onnxPath = DEFAULT_V5_ONNX_PATH,
  expectedSha256 = V5_ONNX_SHA256,
  cache = defaultCache
) {
  if (!onnxPath || typeof onnxPath !== "string") {
    return {
      ok: false,
      status: 404,
      reason: "missing",
      error: "v5 ONNX model artifact not found",
    };
  }

  const normalizedExpected = String(expectedSha256 || "").trim().toLowerCase();
  const cacheKey = `${onnxPath}|${normalizedExpected}`;
  const canCache =
    cache && typeof cache.get === "function" && typeof cache.set === "function";

  let stat;
  try {
    stat = await fs.promises.stat(onnxPath);
  } catch (err) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return {
        ok: false,
        status: 404,
        reason: "missing",
        error: "v5 ONNX model artifact not found",
      };
    }
    return {
      ok: false,
      status: 503,
      reason: "unreadable",
      error: "v5 ONNX model artifact could not be read",
    };
  }

  if (!stat.isFile()) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    return {
      ok: false,
      status: 404,
      reason: "missing",
      error: "v5 ONNX model artifact not found",
    };
  }

  if (stat.size <= 0 || stat.size > V5_MAX_BYTES) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    return {
      ok: false,
      status: 503,
      reason: "oversized",
      error: "v5 ONNX model exceeds 20 MB safety cap",
    };
  }

  if (canCache) {
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ...cached.result };
    }
  }

  let hashed;
  try {
    hashed = await streamSha256(onnxPath, V5_MAX_BYTES);
  } catch (err) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    if (err && err.code === "OVERSIZED") {
      return {
        ok: false,
        status: 503,
        reason: "oversized",
        error: "v5 ONNX model exceeds 20 MB safety cap",
      };
    }
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return {
        ok: false,
        status: 404,
        reason: "missing",
        error: "v5 ONNX model artifact not found",
      };
    }
    return {
      ok: false,
      status: 503,
      reason: "unreadable",
      error: "v5 ONNX model artifact could not be read",
    };
  }

  if (hashed.bytesRead <= 0 || hashed.bytesRead > V5_MAX_BYTES) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    return {
      ok: false,
      status: 503,
      reason: "oversized",
      error: "v5 ONNX model exceeds 20 MB safety cap",
    };
  }

  const digest = hashed.digest;
  if (digest !== normalizedExpected) {
    if (canCache && typeof cache.delete === "function") cache.delete(cacheKey);
    return {
      ok: false,
      status: 503,
      reason: "sha256_mismatch",
      error: "v5 ONNX model SHA-256 verification failed",
      actualSha256: digest,
    };
  }

  const result = {
    ok: true,
    status: 200,
    path: onnxPath,
    bytes: stat.size,
    sha256: digest,
    etag: `"sha256-${digest}"`,
  };

  if (canCache) {
    cache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      result,
    });
  }

  return { ...result };
}

async function statRegularFileBytes(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { available: false, bytes: null };
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile()) {
      return { available: true, bytes: stat.size };
    }
  } catch {}
  return { available: false, bytes: null };
}

async function getLocalTiersMetadata({
  onnxPath = DEFAULT_V5_ONNX_PATH,
  expectedSha256 = V5_ONNX_SHA256,
  v41Path = DEFAULT_V41_WEIGHTS_PATH,
  cache = defaultCache,
} = {}) {
  const normalizedExpected = String(expectedSha256 || "").trim().toLowerCase();
  const [v41Info, v5Check] = await Promise.all([
    statRegularFileBytes(v41Path),
    verifyOnnxFile(onnxPath, normalizedExpected, cache),
  ]);

  return {
    defaultTier: "v4.1",
    tiers: [
      {
        id: "v4.1",
        name: "SkyNetLite v4.1",
        runtime: "js-cpu",
        url: "/ai-models/skysentry_classifier.json",
        bytes: v41Info.bytes,
        sizeMB: 2.5,
        inputSize: 64,
        classes: ["bird", "drone", "other"],
        default: true,
        available: v41Info.available,
        advisoryOnly: true,
      },
      {
        id: "v5",
        name: "MobileNetV3 Large v5 (ONNX)",
        architecture: "mobilenet_v3_large",
        runtime: "onnxruntime-web",
        fallbackTier: "v4.1",
        url: "/ai-models/skysentry_v5.onnx",
        bytes: v5Check.ok ? v5Check.bytes : null,
        sizeMB: 16.8,
        inputSize: 96,
        inputName: "crop96_normalised",
        outputName: "logits",
        normalization: {
          mean: [0.485, 0.456, 0.406],
          std: [0.229, 0.224, 0.225],
        },
        sha256: normalizedExpected,
        classes: ["bird", "drone", "other"],
        default: false,
        available: v5Check.ok,
        reason: v5Check.ok ? null : v5Check.reason,
        advisoryOnly: true,
      },
    ],
  };
}

function setResponseHeader(res, name, value) {
  if (typeof res.setHeader === "function") {
    res.setHeader(name, value);
  } else if (typeof res.set === "function") {
    res.set(name, value);
  }
}

function applyStatus(res, code) {
  if (typeof res.status === "function") {
    return res.status(code) || res;
  }
  res.statusCode = code;
  return res;
}

function getRequestHeader(req, headerName) {
  if (!req) return undefined;
  const lower = headerName.toLowerCase();
  if (typeof req.get === "function") {
    const val = req.get(lower);
    if (val !== undefined) return val;
  }
  const headers = req.headers;
  if (!headers || typeof headers !== "object") return undefined;
  if (headers[lower] !== undefined) return headers[lower];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function ifNoneMatchMatches(headerValue, etag) {
  if (!headerValue || !etag) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : String(headerValue);
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  const stripWeak = (tag) => tag.trim().replace(/^W\//i, "");
  const expected = stripWeak(etag);
  return trimmed.split(",").some((candidate) => stripWeak(candidate) === expected);
}

async function streamFileToResponse(filePath, req, res) {
  if (typeof res.on === "function" && typeof res.write === "function") {
    await new Promise((resolve) => {
      const stream = fs.createReadStream(filePath);
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        if (typeof res.off === "function") {
          res.off("close", onAbort);
          res.off("finish", done);
          res.off("error", onAbort);
        }
        if (req && typeof req.off === "function") {
          req.off("aborted", onAbort);
        }
        resolve();
      };

      const onAbort = () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
        done();
      };

      res.on("close", onAbort);
      res.on("finish", done);
      res.on("error", onAbort);
      if (req && typeof req.on === "function") {
        req.on("aborted", onAbort);
      }

      stream.on("error", (err) => {
        if (!res.headersSent && typeof res.json === "function") {
          if (typeof res.removeHeader === "function") {
            res.removeHeader("Content-Length");
            res.removeHeader("ETag");
            res.removeHeader("X-Model-Sha256");
            res.removeHeader("Content-Type");
          }
          setResponseHeader(res, "Cache-Control", "no-store");
          setResponseHeader(res, "X-Content-Type-Options", "nosniff");
          applyStatus(res, 503).json({
            error: "v5 ONNX model artifact could not be read",
            reason: err && err.code === "ENOENT" ? "missing" : "unreadable",
          });
        } else if (typeof res.destroy === "function") {
          res.destroy(err);
        } else if (typeof res.end === "function") {
          res.end();
        }
        done();
      });

      stream.pipe(res);
    });
    return;
  }

  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      if (typeof res.write === "function") {
        res.write(chunk);
      } else {
        chunks.push(chunk);
      }
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  if (typeof res.end === "function") {
    if (typeof res.write === "function") {
      res.end();
    } else {
      res.end(Buffer.concat(chunks));
    }
  }
}

function registerV5ModelRoutes(app, options = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError("registerV5ModelRoutes requires an Express app with app.get()");
  }

  const {
    onnxPath = DEFAULT_V5_ONNX_PATH,
    expectedSha256 = V5_ONNX_SHA256,
    v41Path = DEFAULT_V41_WEIGHTS_PATH,
    cache = defaultCache,
  } = options || {};

  app.get("/ai-models/skysentry_v5.onnx", async (req, res) => {
    const check = await verifyOnnxFile(onnxPath, expectedSha256, cache);
    if (!check.ok) {
      setResponseHeader(res, "Cache-Control", "no-store");
      setResponseHeader(res, "X-Content-Type-Options", "nosniff");
      return applyStatus(res, check.status).json({
        error: check.error,
        reason: check.reason,
      });
    }

    const ifNoneMatch = getRequestHeader(req, "if-none-match");
    if (ifNoneMatchMatches(ifNoneMatch, check.etag)) {
      setResponseHeader(res, "Cache-Control", V5_IMMUTABLE_CACHE_CONTROL);
      setResponseHeader(res, "ETag", check.etag);
      setResponseHeader(res, "X-Content-Type-Options", "nosniff");
      return applyStatus(res, 304).end();
    }

    setResponseHeader(res, "Content-Type", "application/octet-stream");
    setResponseHeader(res, "Content-Length", String(check.bytes));
    setResponseHeader(res, "Cache-Control", V5_IMMUTABLE_CACHE_CONTROL);
    setResponseHeader(res, "ETag", check.etag);
    setResponseHeader(res, "X-Content-Type-Options", "nosniff");
    setResponseHeader(res, "X-Model-Sha256", check.sha256);

    if (String(req?.method || "GET").toUpperCase() === "HEAD") {
      return applyStatus(res, 200).end();
    }

    applyStatus(res, 200);
    await streamFileToResponse(check.path, req, res);
  });

  app.get("/api/models/local-tiers", async (_req, res) => {
    const metadata = await getLocalTiersMetadata({
      onnxPath,
      expectedSha256,
      v41Path,
      cache,
    });
    setResponseHeader(res, "Cache-Control", "no-store");
    setResponseHeader(res, "X-Content-Type-Options", "nosniff");
    return applyStatus(res, 200).json(metadata);
  });

  return app;
}

module.exports = {
  V5_ONNX_SHA256,
  V5_MAX_BYTES,
  V5_CACHE_SECONDS,
  DEFAULT_V5_ONNX_PATH,
  DEFAULT_V41_WEIGHTS_PATH,
  verifyOnnxFile,
  getLocalTiersMetadata,
  registerV5ModelRoutes,
};
