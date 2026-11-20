"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LONG_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  resolvePublicUrlPath,
  applyPerfStaticHeaders,
} = require("../perf-headers");

const publicDir = path.join(__dirname, "..", "public");
const indexHtmlPath = path.join(publicDir, "index.html");
const filmHtmlPath = path.join(publicDir, "film.html");
const towerHtmlPath = path.join(publicDir, "tower.html");

function stripNoscript(html) {
  return html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

function stripNonDomBlocks(html) {
  return stripNoscript(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

function findBlockingGoogleFontLinks(html) {
  const domHtml = stripNonDomBlocks(html);
  const links = domHtml.match(/<link\b[^>]*>/gi) || [];
  return links.filter((tag) => {
    const isStylesheet = /\brel\s*=\s*(?:"stylesheet"|'stylesheet')/i.test(tag);
    const isGoogleFonts = /\bhref\s*=\s*(?:"https:\/\/fonts\.googleapis\.com\/[^"]*"|'https:\/\/fonts\.googleapis\.com\/[^']*')/i.test(tag);
    if (!isStylesheet || !isGoogleFonts) return false;
    const nonBlocking =
      /\bmedia\s*=\s*(?:"print"|'print')/i.test(tag) &&
      /\bonload\s*=\s*(?:"this\.media='all'"|'this\.media="all"')/i.test(tag);
    return !nonBlocking;
  });
}

function createMockRes(initialHeaders = {}) {
  const headers = new Map();
  for (const [k, v] of Object.entries(initialHeaders)) {
    headers.set(k.toLowerCase(), { name: k, value: v });
  }
  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), { name, value });
    },
    getHeader(name) {
      return headers.get(name.toLowerCase())?.value;
    },
    snapshot() {
      const out = {};
      for (const { name, value } of headers.values()) out[name] = value;
      return out;
    },
  };
}

const INDEX_DISCLOSURES = [
  "SkySentry is a video-only monitoring prototype with server-assigned risk and advisory tower warnings.",
  "SkySentry is a prototype that sends camera video to a server and shows potential hazards on a tower dashboard. It is advisory only, not a source of runway clearance.",
  "An advisory video-monitoring prototype. Not a source of runway clearance.",
  "This is an illustrated prototype demonstration; detection readings, risk events, reports and charts are simulated.",
  "Illustrated prototype. Detection readings, alerts, reports and charts in the film are simulated.",
  "SkySentry supplements observation. It is not radar and does not detect every hazard.",
  "An optional image review is advisory and does not change server-assigned risk.",
  "The dashboard shows warnings and coverage gaps. Voice is opt-in for fresh alerts; replay is silent. Map coverage isn’t a measured object location.",
  "The JPEG stream carries no microphone signal. Small or distant objects and poor visibility can limit detection.",
  "Projected entry into a surveyed image mask is not a runway arrival time.",
  "This prototype does not replace radar, approved procedures or human judgment.",
  "Authorized cameras and dashboards connect at a registered airport. Delivery and reports depend on the network and storage; neither is guaranteed.",
  "Explore browser tests for synthetic conditions. These exercises do not measure verified field performance.",
  "Recorded clips and synthetic scenes do not publish live events, trigger tower alerts, or validate airport performance.",
  "Prototype demonstration. Film scenery is illustrative and readings are simulated.",
  "Reports are advisory. A camera’s view on the map is not a measured object location.",
];

const FILM_DISCLOSURES = [
  "A 100-second 3D film illustrating simulated video detection and tower warnings.",
  "An advisory video-monitoring prototype. Not a source of runway clearance.",
  "This is an illustrated prototype demonstration; detection readings, risk events, reports and charts are simulated.",
  "The JPEG feed does not carry drone audio. Distance and visibility can limit detection.",
  "Reports are advisory. A camera’s view on the map is not a measured object location.",
];

test("optimizeGeneratedHtml fixes render-blocking Google Fonts, gstatic preconnect, and LCP poster on real index.html", async () => {
  const { optimizeGeneratedHtml } = await import("../scripts/perf-html-transform.mjs");
  const rawIndex = fs.readFileSync(indexHtmlPath, "utf8");
  const rawTower = fs.readFileSync(towerHtmlPath, "utf8");

  // Confirm tower.html already uses the non-blocking pattern we match.
  assert.equal(findBlockingGoogleFontLinks(rawTower).length, 0);

  // Confirm raw index.html currently exhibits the exact critical-path bugs.
  assert.equal(findBlockingGoogleFontLinks(rawIndex).length, 2, "raw index.html has 2 render-blocking Google Fonts links");
  assert.doesNotMatch(rawIndex, /fonts\.gstatic\.com/);

  const optimized = optimizeGeneratedHtml(rawIndex, { page: "index" });
  assert.equal(optimizeGeneratedHtml(rawIndex), optimized, "page defaults to 'index'");

  // 1. Zero render-blocking Google Fonts stylesheet links anywhere outside <noscript>.
  assert.deepEqual(findBlockingGoogleFontLinks(optimized), []);

  // 2. Both Geist (<head>) and Barlow Condensed (<body>) links are non-blocking with <noscript> fallbacks.
  const asyncLinks = stripNoscript(optimized).match(/<link\b[^>]*https:\/\/fonts\.googleapis\.com\/css2\?[^>]*>/gi) || [];
  assert.equal(asyncLinks.length, 2);
  for (const link of asyncLinks) {
    assert.match(link, /\bmedia="print"/);
    assert.match(link, /\bonload="this\.media='all'"/);
  }

  const noscriptFallbacks = optimized.match(/<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"><\/noscript>/g) || [];
  assert.equal(noscriptFallbacks.length, 2);
  assert.ok(noscriptFallbacks.some((tag) => tag.includes("family=Geist:")));
  assert.ok(noscriptFallbacks.some((tag) => tag.includes("family=Barlow+Condensed:")));

  // 3. Preconnect to https://fonts.gstatic.com crossorigin added once in <head>.
  const headMatch = optimized.match(/<head>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch, "<head> section exists");
  const gstaticInHead = headMatch[1].match(/<link\b[^>]*fonts\.gstatic\.com[^>]*>/gi) || [];
  assert.equal(gstaticInHead.length, 1);
  assert.equal(gstaticInHead[0], '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  assert.equal((optimized.match(/fonts\.gstatic\.com/g) || []).length, 1);

  // 4. Local override stylesheet remains synchronous to prevent FOUC.
  assert.match(optimized, /<link rel="stylesheet" href="\/css\/site\.css">/);

  // 5. Hero #filmPoster SVG gets fetchpriority="high" decoding="async" for immediate LCP paint.
  const posterMatch = optimized.match(/<div class="film-poster" id="filmPoster">([\s\S]*?)<\/div>/);
  assert.ok(posterMatch, "#filmPoster container preserved");
  assert.match(
    posterMatch[1],
    /<img src="\.\/film-poster\.svg" alt="" width="1280" height="720" fetchpriority="high" decoding="async">/,
  );

  // 6. Strict idempotency across repeated runs.
  const secondPass = optimizeGeneratedHtml(optimized, { page: "index" });
  const thirdPass = optimizeGeneratedHtml(secondPass, { page: "index" });
  assert.equal(secondPass, optimized);
  assert.equal(thirdPass, optimized);

  // 7. Every word of site disclosures and inline scripts/styles is preserved verbatim.
  for (const disclosure of INDEX_DISCLOSURES) {
    assert.ok(optimized.includes(disclosure), `missing disclosure: ${disclosure}`);
  }

  // Reversible diff check: undoing ONLY the 3 expected enhancements recovers rawIndex byte-for-byte.
  const reverted = optimized
    .replace('\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', "")
    .replaceAll(' media="print" onload="this.media=\'all\'"', "")
    .replace(/\n<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"><\/noscript>/g, "")
    .replace(' fetchpriority="high" decoding="async"', "");
  assert.equal(reverted, rawIndex, "no unintended text, script, style, or disclosure mutations");
});

test("optimizeGeneratedHtml optimizes real film.html and preserves all disclosures and idempotency", async () => {
  const { optimizeGeneratedHtml } = await import("../scripts/perf-html-transform.mjs");
  const rawFilm = fs.readFileSync(filmHtmlPath, "utf8");

  assert.equal(findBlockingGoogleFontLinks(rawFilm).length, 2, "raw film.html has 2 render-blocking Google Fonts links");

  const optimized = optimizeGeneratedHtml(rawFilm, { page: "film" });
  assert.deepEqual(findBlockingGoogleFontLinks(optimized), []);

  const headMatch = optimized.match(/<head>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch);
  const gstaticInHead = headMatch[1].match(/<link\b[^>]*fonts\.gstatic\.com[^>]*>/gi) || [];
  assert.equal(gstaticInHead.length, 1);
  assert.equal(gstaticInHead[0], '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');

  const noscriptFallbacks = optimized.match(/<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"><\/noscript>/g) || [];
  assert.equal(noscriptFallbacks.length, 2);

  // Local stylesheet stays synchronous.
  assert.match(optimized, /<link rel="stylesheet" href="\/css\/film\.css">/);

  // Idempotent on film.html as well.
  assert.equal(optimizeGeneratedHtml(optimized, { page: "film" }), optimized);

  for (const disclosure of FILM_DISCLOSURES) {
    assert.ok(optimized.includes(disclosure), `missing film disclosure: ${disclosure}`);
  }
});

test("optimizeGeneratedHtml handles attribute ordering, existing gstatic preconnect, and script/style masking", async () => {
  const { optimizeGeneratedHtml } = await import("../scripts/perf-html-transform.mjs");

  const synthetic = `<!doctype html>
<html lang="en">
<head>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link href='https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap' rel='stylesheet' />
<script>const literal = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fake">';</script>
</head>
<body>
<div id="filmPoster"><img width="1280" height="720" src="./film-poster.svg" alt=""></div>
</body>
</html>`;

  const once = optimizeGeneratedHtml(synthetic, { page: "index" });
  assert.deepEqual(findBlockingGoogleFontLinks(once), []);
  assert.equal((once.match(/fonts\.gstatic\.com/g) || []).length, 1);
  assert.match(once, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
  assert.match(once, /<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter:wght@400;600&display=swap"><\/noscript>/);
  assert.match(once, /const literal = '<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Fake">';/);
  assert.match(once, /<img width="1280" height="720" src="\.\/film-poster\.svg" alt="" fetchpriority="high" decoding="async">/);
  assert.equal(optimizeGeneratedHtml(once, { page: "index" }), once);
  assert.equal(optimizeGeneratedHtml(synthetic, { page: "index.html" }), once);

  // Single-quoted already-async link keeps its attributes intact and gains a <noscript> fallback once.
  const singleQuotedAsync = `<!doctype html><html><head><link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=Geist' media='print' onload='this.media="all"'></head><body></body></html>`;
  const upgradedSingle = optimizeGeneratedHtml(singleQuotedAsync);
  assert.match(upgradedSingle, /media='print' onload='this\.media="all"'/);
  assert.match(upgradedSingle, /<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Geist"><\/noscript>/);
  assert.equal(optimizeGeneratedHtml(upgradedSingle), upgradedSingle);

  assert.throws(() => optimizeGeneratedHtml(null), TypeError);
});

test("applyPerfStaticHeaders sets long-lived SWR cache on static asset folders and Vary on compressible files", () => {
  const longCachedCompressible = [
    path.join(publicDir, "vendor", "three.module.js"),
    path.join(publicDir, "vendor", "leaflet", "leaflet.css"),
    path.join(publicDir, "assets", "narrow-body-airliner.gltf.json"),
    path.join(publicDir, "assets", "derelict_airfield_01_1k.hdr.json"),
    path.join(publicDir, "ai-models", "tf.min.js"),
    path.join(publicDir, "ai-models", "skysentry_classifier.json"),
    path.join(publicDir, "clips", "clips.json"),
    path.join(publicDir, "brand", "favicon.svg"),
    path.join(publicDir, "detection", "models", "ort-wasm-simd.wasm"),
  ];

  for (const file of longCachedCompressible) {
    const res = createMockRes();
    // Pass a fake fs.Stats 3rd arg just like express.static(root, { setHeaders }) does.
    applyPerfStaticHeaders(res, file, { size: 4096 });
    assert.equal(res.getHeader("Cache-Control"), LONG_CACHE_CONTROL, `Cache-Control for ${file}`);
    assert.equal(res.getHeader("Vary"), "Accept-Encoding", `Vary for ${file}`);
  }

  const longCachedBinary = [
    path.join(publicDir, "assets", "narrow-body-airliner.glb"),
    path.join(publicDir, "assets", "clean_asphalt_diff_1k.jpg"),
    path.join(publicDir, "clips", "drone-hover.mp4"),
    path.join(publicDir, "clips", "drone-hover.webm"),
    path.join(publicDir, "promo", "airfield-defense.mp4"),
    path.join(publicDir, "brand", "favicon-32.png"),
    path.join(publicDir, "detection", "models", "drone_audio_v0.onnx"),
  ];

  for (const file of longCachedBinary) {
    const res = createMockRes();
    applyPerfStaticHeaders(res, file, { size: 16384 });
    assert.equal(res.getHeader("Cache-Control"), LONG_CACHE_CONTROL, `Cache-Control for ${file}`);
    assert.equal(res.getHeader("Vary"), undefined, `binary asset ${file} should not add Vary: Accept-Encoding`);
  }
});

test("applyPerfStaticHeaders preserves no-cache revalidation on mutable HTML, JS, MJS, CSS, and root SVG", () => {
  const revalidatedCompressible = [
    path.join(publicDir, "index.html"),
    path.join(publicDir, "film.html"),
    path.join(publicDir, "tower.html"),
    path.join(publicDir, "cinema.js"),
    path.join(publicDir, "js", "tower.js"),
    path.join(publicDir, "js", "tower-monitoring.mjs"),
    path.join(publicDir, "css", "site.css"),
    path.join(publicDir, "css", "app.css"),
    path.join(publicDir, "detection", "index.js"),
    path.join(publicDir, "film-poster.svg"),
    // Even if an HTML page lived inside a static folder, HTML must always revalidate.
    path.join(publicDir, "vendor", "readme.html"),
  ];

  for (const file of revalidatedCompressible) {
    const res = createMockRes();
    applyPerfStaticHeaders(res, file);
    assert.equal(res.getHeader("Cache-Control"), REVALIDATE_CACHE_CONTROL, `Cache-Control for ${file}`);
    assert.equal(res.getHeader("Vary"), "Accept-Encoding", `Vary for ${file}`);
  }
});

test("applyPerfStaticHeaders normalizes Windows/POSIX paths and merges Vary headers idempotently", () => {
  assert.equal(
    resolvePublicUrlPath("C:\\repo\\PRANAV\\public\\vendor\\three.module.js", "C:\\repo\\PRANAV\\public"),
    "/vendor/three.module.js",
  );
  assert.equal(resolvePublicUrlPath("/srv/app/public/brand/favicon.svg", "/different/root"), "/brand/favicon.svg");
  assert.equal(resolvePublicUrlPath("clips/clips.json"), "/clips/clips.json");

  const resWithOrigin = createMockRes({ Vary: "Origin" });
  applyPerfStaticHeaders(resWithOrigin, "/vendor/three.module.js");
  applyPerfStaticHeaders(resWithOrigin, "/vendor/three.module.js");
  assert.equal(resWithOrigin.getHeader("Vary"), "Origin, Accept-Encoding");
  assert.equal(resWithOrigin.getHeader("Cache-Control"), LONG_CACHE_CONTROL);

  // Also works with minimal response mocks that expose setHeader() without getHeader().
  const recorded = {};
  applyPerfStaticHeaders({ setHeader: (k, v) => { recorded[k] = v; } }, "/index.html");
  assert.equal(recorded["Cache-Control"], REVALIDATE_CACHE_CONTROL);
  assert.equal(recorded.Vary, "Accept-Encoding");
});
