const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const promoPath = path.join(__dirname, '..', 'scripts', 'promo-section.html');
const cssPath = path.join(__dirname, '..', 'public', 'css', 'landing-live-ai.css');
const clipsDir = path.join(__dirname, '..', 'public', 'clips');

test('promo-section.html preserves required safety disclaimer and navigation links', () => {
  const html = fs.readFileSync(promoPath, 'utf8');

  assert.match(html, /<section class="sec" id="promo">/);
  assert.ok(
    html.includes('Recorded clips and synthetic scenes do not publish live events, trigger tower alerts, or validate airport performance.'),
    'exact safety disclaimer must remain intact',
  );
  assert.match(html, /<a\b[^>]*href="\/demo\.html"[^>]*>Browse demonstrations<\/a>/);
  assert.match(html, /<a\b[^>]*href="#film"[^>]*>Back to the illustrated film<\/a>/);
  assert.doesNotMatch(html, /<video\b[^>]*\b(?:src=|autoplay\b)/i, 'must not auto-load or autoplay media before user interaction');
});

test('promo-section.html exposes #landingLiveAi controls, 16:9 stage canvases, and Geist Mono telemetry selectors', () => {
  const html = fs.readFileSync(promoPath, 'utf8');

  assert.match(html, /<div class="live-ai-card" id="landingLiveAi"(?:\s|>)/);

  for (const [clip, pressed] of [
    ['starling-murmuration', 'true'],
    ['drone-hover', 'false'],
    ['gulls-sky', 'false'],
  ]) {
    const buttonRe = new RegExp(
      `<button\\b(?=[^>]*\\btype="button")(?=[^>]*\\bdata-clip="${clip}")(?=[^>]*\\baria-pressed="${pressed}")[^>]*>`,
    );
    assert.match(html, buttonRe, `missing accessible clip button for ${clip}`);
    assert.equal(fs.existsSync(path.join(clipsDir, `${clip}.mp4`)), true, `missing ${clip}.mp4 asset`);
    assert.equal(fs.existsSync(path.join(clipsDir, `${clip}.jpg`)), true, `missing ${clip}.jpg poster`);
  }

  assert.match(
    html,
    /<button\b(?=[^>]*\btype="button")(?=[^>]*\bdata-live-ai-toggle(?:\s|>|=))(?=[^>]*\baria-pressed="false")[^>]*>Run v4\.1 local AI in browser · 2\.5 MB<\/button>/,
  );

  assert.match(html, /<canvas\b[^>]*\bdata-live-ai-video(?:\s|>|=)[^>]*><\/canvas>/);
  assert.match(html, /<canvas\b[^>]*\bdata-live-ai-overlay(?:\s|>|=)[^>]*><\/canvas>/);
  assert.match(html, /<img\b[^>]*\bdata-live-ai-poster(?:\s|>|=)[^>]*\bsrc="\/clips\/starling-murmuration\.jpg"[^>]*>/);

  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    assert.match(html, new RegExp(`class="live-ai-tick ${corner}"`), `missing ${corner} corner HUD tick`);
  }

  for (const attr of ['data-ai-ms', 'data-ai-fps', 'data-ai-tracks', 'data-ai-verdict']) {
    assert.match(html, new RegExp(`\\b${attr}(?:\\s|>|=)`), `missing telemetry selector ${attr}`);
  }

  for (const cls of ['bird', 'drone', 'other']) {
    assert.match(
      html,
      new RegExp(`<div\\b(?=[^>]*\\bdata-prob="${cls}")(?=[^>]*\\brole="meter")[^>]*><\\/div>`),
      `missing probability meter for ${cls}`,
    );
  }

  assert.match(html, /100% locally in a browser Web Worker/i);
  assert.match(html, /SkyNetLite[\s\S]*v4\.1[\s\S]*472K params/);
  assert.match(html, /zero cloud uploads/i);
});

test('promo-section.html splices cleanly into ATHARV site.html via sync-web anchor', () => {
  const siteSource = fs.readFileSync(path.join(__dirname, '..', '..', 'ATHARV', 'skysentry', 'dist', 'site.html'), 'utf8');
  const promo = fs.readFileSync(promoPath, 'utf8').replace(/\r\n/g, '\n');
  const riskAnchor = '<section class="sec" id="risk">';

  assert.ok(siteSource.includes(riskAnchor), 'ATHARV site.html must contain #risk anchor');
  const composed = siteSource.replace(riskAnchor, `${promo}\n  ${riskAnchor}`);
  assert.ok(composed.includes('id="landingLiveAi"'));
  assert.ok(composed.indexOf('id="promo"') < composed.indexOf('id="risk"'));
});

test('landing-live-ai.css honors site.css theme tokens, 16:9 stage geometry, and prefers-reduced-motion', () => {
  const css = fs.readFileSync(cssPath, 'utf8');

  for (const token of ['--paper', '--card', '--ink-s', '--line-s', '--mono-s']) {
    assert.match(css, new RegExp(`var\\(${token}\\b`), `expected CSS token ${token}`);
  }
  assert.match(css, /\.live-ai-stage\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.live-ai-prob-fill\s*\{[\s\S]*?transition:/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition:\s*none\s*!important/);
});
