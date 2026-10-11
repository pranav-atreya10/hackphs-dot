// Records the 100-second SkySentry film (film.html) to a YouTube-ready 1080p MP4.
//
//   npm run record-film -- --url http://localhost:8080/film.html --out ~/Downloads/SkySentry-film.mp4
//
// The film is a live 3D animation, so this renders it frame by frame instead of screen-recording:
// headless Chrome (already installed) runs the page with a fake clock that only moves when we say so,
// we step exactly 1/fps per frame and screenshot it, and scripts/mp4-encoder.swift (macOS AVFoundation)
// turns the frames into H.264. Every frame is exact however slow the machine renders. No downloads.
// Needs: macOS, Google Chrome, Xcode command-line tools (swiftc), and the site running (npm start).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const opt = { url: 'http://localhost:8080/film.html', out: join(homedir(), 'Downloads', 'SkySentry-film.mp4'), width: 1920, height: 1080,
  fps: 30, hold: 2, bitrate: 12_000_000, seconds: 0, captions: true, faststart: false, chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '');
  if (key === 'no-captions') { opt.captions = false; continue; }
  if (key === 'faststart') { opt.faststart = true; continue; }
  if (!(key in opt)) throw new Error(`unknown option --${key}`);
  const value = argv[++i];
  opt[key] = typeof opt[key] === 'number' ? Number(value) : value.replace(/^~(?=\/)/, homedir());
}
opt.out = resolve(opt.out);
if (!existsSync(opt.chrome)) throw new Error(`Chrome not found at ${opt.chrome}; pass --chrome <path>`);

// ---------- encoder: compile once, cached by source hash ----------
const encoderSrc = fileURLToPath(new URL('./mp4-encoder.swift', import.meta.url));
const encoder = join(tmpdir(), `skysentry-mp4-encoder-${createHash('sha256').update(readFileSync(encoderSrc)).digest('hex').slice(0, 12)}`);
if (!existsSync(encoder)) {
  console.log('Compiling the MP4 encoder (about a minute, first run only)…');
  execFileSync('swiftc', ['-O', '-suppress-warnings', encoderSrc, '-o', encoder], { stdio: 'inherit' });
}

// ---------- injected into the film page before its scripts run ----------
// The film reads time only through performance.now() and requestAnimationFrame, so owning those owns the film.
// CSS transitions outside the film's own layer animations are also stepped, so nothing runs on wall-clock time.
const pageSetup = ({ captions }) => {
  let now = 0, queue = [];
  const seen = new WeakSet();
  performance.now = () => now;
  window.requestAnimationFrame = cb => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  window.__recStep = ms => {
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) { seen.add(a); a.pause(); a.currentTime = 0; }
      else if (a.playState === 'paused' || a.playState === 'running') { a.pause(); a.currentTime = (a.currentTime || 0) + ms; }
    }
    now += ms;
    const callbacks = queue; queue = [];
    callbacks.forEach(cb => cb(now));
    return document.getElementById('caption')?.textContent || '';
  };
  // Show only the stage, full frame, with the film's captions as burned-in subtitles.
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      html,body{background:#000!important;overflow:hidden!important}
      .wrap{padding:0!important;max-width:none!important}
      .wrap > :not(.stage):not(#caption){display:none!important}
      .stage{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;aspect-ratio:auto!important;border-radius:0!important;box-shadow:none!important}
      #caption{${captions ? '' : 'display:none!important;'}position:fixed;z-index:20;left:50%;bottom:4.2vh;transform:translateX(-50%);width:max-content;max-width:54vw;min-height:0;margin:0;
        padding:.4em .85em;border-radius:.45em;background:rgba(0,0,0,.6);color:#fff;font:500 1.42vw/1.42 "Geist",system-ui,sans-serif;text-align:center;text-wrap:balance;hyphens:none}
      #caption:empty{display:none}`;
    document.head.appendChild(style);
  });
};

// ---------- Chrome over the DevTools protocol (Node's built-in WebSocket) ----------
const profile = mkdtempSync(join(tmpdir(), 'skysentry-rec-'));
const chrome = spawn(opt.chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${opt.width},${opt.height}`,
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1',
  // keep Chrome's temporary profile tiny: no disk, media or shader caches
  '--disk-cache-size=1', '--media-cache-size=1', '--disable-gpu-shader-disk-cache', '--disable-component-update', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
}
if (!port) throw new Error('Chrome did not start');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0; const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
};
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: opt.width, height: opt.height, deviceScaleFactor: 1, mobile: false });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${pageSetup})(${JSON.stringify({ captions: opt.captions })})` });
console.log(`Loading ${opt.url}`);
await cdp('Page.navigate', { url: opt.url });

// Wait for every detail asset; zero-length steps let the page settle without moving the film's clock.
const started = Date.now();
for (;;) {
  const state = await evaluate(`(() => { window.__recStep && __recStep(0); const s = document.getElementById('stage');
    return { assets: s && s.dataset.assets, loader: !!document.getElementById('assetLoader'), time: document.getElementById('time')?.textContent || '' }; })()`).catch(() => null);
  if (state && state.assets === 'ready' && !state.loader) { opt.total = state.time; break; }
  if (state && (state.assets === 'partial') && !state.loader) { console.warn('Some detail assets failed to load; recording the base scene.'); opt.total = state.time; break; }
  if (Date.now() - started > 180000) throw new Error(`film did not finish loading (assets: ${state?.assets})`);
  await sleep(250);
}
await evaluate('document.fonts.ready.then(() => true)');
const [, mm, ss] = /\/\s*(\d+):(\d+)/.exec(opt.total) || [];
const seconds = opt.seconds || (mm ? Number(mm) * 60 + Number(ss) : 100);
const frames = Math.round(seconds * opt.fps), holdFrames = Math.round(opt.hold * opt.fps);
// Fail before the long render, not after it: the MP4 (twice that with --faststart) must fit on disk.
const needMB = Math.ceil(opt.bitrate * (seconds + opt.hold) / 8 / 1e6 * 1.1 * (opt.faststart ? 2 : 1));
const fs = statfsSync(dirname(opt.out)), freeMB = Math.floor(fs.bavail * fs.bsize / 1e6);
if (freeMB < needMB + 50) throw new Error(`not enough disk space in ${dirname(opt.out)}: about ${needMB} MB needed, ${freeMB} MB free. Free some space or lower --bitrate.`);
console.log(`Recording ${seconds}s at ${opt.width}×${opt.height} ${opt.fps}fps (${frames} frames + ${opt.hold}s hold) → ${opt.out}`);

// ---------- capture ----------
const enc = spawn(encoder, [opt.out, String(opt.width), String(opt.height), String(opt.fps), String(opt.bitrate), opt.faststart ? 'faststart' : 'plain'], { stdio: ['pipe', 'inherit', 'inherit'] });
const encDone = new Promise((res, rej) => enc.on('exit', code => code === 0 ? res() : rej(new Error(`encoder exited with ${code}`))));
const write = buf => new Promise(res => { const head = Buffer.alloc(4); head.writeUInt32BE(buf.length); enc.stdin.write(head); enc.stdin.write(buf) ? res() : enc.stdin.once('drain', res); });

const step = 1000 / opt.fps, t0 = Date.now();
let last;
// Caption changes become YouTube subtitles (.srt next to the MP4), timed to the exact frame they appear on.
const cues = []; let cue = null;
const srtTime = f => { const ms = Math.round(f * 1000 / opt.fps), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const freeMBNow = () => { const f = statfsSync(dirname(opt.out)); return Math.floor(f.bavail * f.bsize / 1e6); };
for (let i = 0; i < frames; i++) {
  // Stop cleanly instead of filling the disk (a full disk breaks the MP4 and can destabilise macOS).
  if (i % opt.fps === 0 && freeMBNow() < 150) { enc.kill(); throw new Error(`stopped at ${(i / opt.fps).toFixed(0)}s: under 150 MB of disk left. Free some space and run again.`); }
  const text = (await evaluate(`__recStep(${i > 0 ? step : 0})`)).trim();
  if (text !== cue?.text) { if (cue) { cue.end = i; cues.push(cue); } cue = text ? { text, start: i } : null; }
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 93, captureBeyondViewport: false });
  last = Buffer.from(data, 'base64');
  await write(last);
  if (i % (opt.fps * 5) === 0 || i === frames - 1) {
    const done = (i + 1) / frames, elapsed = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  ${Math.round(done * 100)}%  film ${(i / opt.fps).toFixed(1)}s / ${seconds}s  ·  ~${Math.round(elapsed / done - elapsed)}s left   `);
  }
}
for (let i = 0; i < holdFrames; i++) await write(last);
if (cue) { cue.end = frames + holdFrames; cues.push(cue); }
const srt = opt.out.replace(/\.mp4$/i, '') + '.srt';
writeFileSync(srt, cues.map((c, k) => `${k + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));
process.stdout.write('\n');
enc.stdin.end();
await encDone;
ws.close();
console.log(`Done: ${opt.out} (${(statSync(opt.out).size / 1e6).toFixed(1)} MB)`);
console.log(`Subtitles: ${srt} (${cues.length} captions). On YouTube: Subtitles → Add language → Upload file → With timing.`);
process.exit(0);
