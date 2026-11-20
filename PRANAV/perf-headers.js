"use strict";

const path = require("node:path");

const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");

// Static asset directories safe for week-long caching with background revalidation.
const LONG_CACHE_RE = /^\/(?:vendor|assets|ai-models|clips|promo|brand|detection\/models)\//i;

// Compressible text, JSON (including .gltf.json / .hdr.json), WASM, and SVG assets.
const COMPRESSIBLE_EXT_RE = /\.(?:html?|css|js|mjs|cjs|json|gltf|map|webmanifest|wasm|svg|txt|xml|md|csv)$/i;

const LONG_CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=86400";
const REVALIDATE_CACHE_CONTROL = "no-cache";

function resolvePublicUrlPath(filePath, publicDir = DEFAULT_PUBLIC_DIR) {
  const raw = String(filePath || "").split("?")[0].split("#")[0];
  if (!raw) return "/";

  if (path.isAbsolute(raw) && publicDir) {
    const rel = path.relative(publicDir, raw).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return "/" + rel.replace(/^\/+/, "");
    }
  }

  const normalized = raw.replace(/\\/g, "/");
  const publicMarker = normalized.lastIndexOf("/public/");
  if (publicMarker !== -1) {
    return normalized.slice(publicMarker + "/public".length);
  }
  if (normalized.startsWith("public/")) {
    return "/" + normalized.slice("public/".length);
  }
  const stripped = normalized.replace(/^\.\//, "");
  return stripped.startsWith("/") ? stripped : "/" + stripped;
}

function appendVaryHeader(res, token) {
  const existing =
    typeof res.getHeader === "function"
      ? (res.getHeader("Vary") ?? res.getHeader("vary"))
      : undefined;

  if (!existing) {
    res.setHeader("Vary", token);
    return;
  }

  const value = Array.isArray(existing) ? existing.join(", ") : String(existing);
  if (value.trim() === "*") return;

  const present = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (!present.includes(token.toLowerCase())) {
    res.setHeader("Vary", `${value}, ${token}`);
  }
}

function applyPerfStaticHeaders(res, filePath, optionsOrStat) {
  if (!res || typeof res.setHeader !== "function") {
    throw new TypeError("applyPerfStaticHeaders requires a response object with setHeader()");
  }

  const publicDir =
    optionsOrStat && typeof optionsOrStat.publicDir === "string"
      ? optionsOrStat.publicDir
      : DEFAULT_PUBLIC_DIR;

  const urlPath = resolvePublicUrlPath(filePath, publicDir);
  const isHtml = /\.html?$/i.test(urlPath);

  if (!isHtml && LONG_CACHE_RE.test(urlPath)) {
    res.setHeader("Cache-Control", LONG_CACHE_CONTROL);
  } else {
    res.setHeader("Cache-Control", REVALIDATE_CACHE_CONTROL);
  }

  if (COMPRESSIBLE_EXT_RE.test(urlPath)) {
    appendVaryHeader(res, "Accept-Encoding");
  }
}

module.exports = {
  LONG_CACHE_RE,
  COMPRESSIBLE_EXT_RE,
  LONG_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  resolvePublicUrlPath,
  applyPerfStaticHeaders,
};
