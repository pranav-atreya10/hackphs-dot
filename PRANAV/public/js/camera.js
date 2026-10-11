// Camera station: Vivan's DetectionEngine runs on the phone or laptop, and its contract events go to
// this server's /camera namespace (Pranav's relay), which stores them and forwards them to the towers.
//
//   video / synthetic sky ──► 320 px frame ──► DetectionEngine.process()
//      ├─ 'frame' → overlay (tracks, flocks, corridor) + stats
//      └─ 'event' → crop snapshot for yellow/red → socket.emit('camera:event')
import { DetectionEngine, SyntheticSky, SCENARIOS, HumDetector, PRESETS } from '/detection/index.js';
import { CocoVerifier } from '/detection/adapters/coco.js';
import { signIn } from '/js/auth.js';

const $ = id => document.getElementById(id);
const video = $('video'), srcCanvas = $('src'), overlay = $('overlay');
const srcCtx = srcCanvas.getContext('2d'), ov = overlay.getContext('2d');
const small = document.createElement('canvas'), smallCtx = small.getContext('2d', { willReadFrequently: true });
const snapCanvas = document.createElement('canvas');
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const WEBCAM_CORRIDOR = [[0, 0], [0.3, 0], [0.3, 1], [0, 1]];   // left 30% = runway side, until you draw your own
const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)' };

let engine = null, sky = null, coco = null, running = false, rafId = 0, t0 = 0, sent = 0, wakeLock = null;
let corridor = JSON.parse(store.get('skysentry.corridor', 'null')) || WEBCAM_CORRIDOR;
let drawing = null, socket = null, auth = null, botState = null, streaming = false, inFlight = false, lastSent = 0, framesSent = 0;
const frameCanvas = document.createElement('canvas'), frameCtx = frameCanvas.getContext('2d');
const STREAM_W = 640, STREAM_FPS = 15;

/* ---------- form state ---------- */
for (const [k, s] of Object.entries(SCENARIOS)) $('scenario').add(new Option(s.describe ? `${k.replace(/_/g, ' ')}: ${s.describe}` : k, k));
for (const id of ['cameraId', 'heading', 'fov', 'lat', 'lon']) {
  const saved = store.get('skysentry.' + id, null);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener('change', () => { store.set('skysentry.' + id, $(id).value); applyCamera(); sendConfig(); });
}
const mode = () => $('mode').value;
$('mode').value = store.get('skysentry.mode', 'stream');
$('mode').addEventListener('change', () => store.set('skysentry.mode', mode()));
function sendConfig() { socket?.connected && socket.emit('camera:config', { camera: cameraConfig(), corridor, preset: [$('tuning').value] }); }
$('tuning').value = store.get('skysentry.tuning', 'phone_15fps');
$('tuning').addEventListener('change', () => { store.set('skysentry.tuning', $('tuning').value); applyCamera(); sendConfig(); });
// Demo clips shipped with the site (public/clips/clips.json).
fetch('/clips/clips.json').then(r => r.json()).then(list => {
  for (const c of list) $('demoClip').add(new Option(`${c.title} · ${c.expect}`, c.file));
}).catch(() => { $('source').querySelector('option[value="demo"]').disabled = true; });
const showSourceFields = () => { $('scenarioWrap').hidden = $('source').value !== 'synthetic'; $('clipWrap').hidden = $('source').value !== 'clip'; $('demoWrap').hidden = $('source').value !== 'demo'; };
$('source').addEventListener('change', showSourceFields);
// Phones default to the real camera; laptops to the synthetic sky so a demo works anywhere.
$('source').value = /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'webcam' : 'synthetic';
showSourceFields();

function cameraConfig() {
  return { lat: +$('lat').value, lon: +$('lon').value, heading_deg: +$('heading').value, hfov_deg: +$('fov').value };
}
function applyCamera() {
  if (!engine) return;
  engine.setConfig({ camera_id: $('cameraId').value.trim() || 'runway-east', camera: cameraConfig() });
  if (PRESETS[$('tuning').value]) engine.setConfig(PRESETS[$('tuning').value]);
}

function log(html) {
  const li = document.createElement('li'); li.innerHTML = `${new Date().toLocaleTimeString()} ${html}`;
  $('log').prepend(li); while ($('log').children.length > 40) $('log').lastChild.remove();
}

/* ---------- connection to the server ---------- */
async function connect() {
  auth = await signIn({ role: 'camera', mount: $('auth') });
  $('who').textContent = auth.label;
  $('signout').onclick = () => auth.signOut();
  // auth as a function so every reconnect gets a fresh sign-in token.
  socket = io('/camera', { auth: cb => auth.socketAuth({ cameraId: $('cameraId').value.trim() || 'runway-east' }).then(cb) });
  socket.on('connect', () => { $('conn').textContent = 'Connected'; $('conn').dataset.ok = '1'; inFlight = false; sendConfig(); });
  // In stream mode the server's bot sends back what it sees, so the phone shows the same boxes as the tower.
  socket.on('bot:state', ({ state }) => { if (mode() === 'stream' && running) { botState = fromCompact(state); draw(botState); showState(botState); } });
  socket.on('bot:status', s => { if (mode() === 'stream') $('aiStatus').textContent = s.mode === 'server' ? 'The server bot is analysing this feed.' : `Server bot unavailable (${s.reason}); a tower screen is analysing the feed instead.`; });
  socket.on('disconnect', () => { $('conn').textContent = 'Reconnecting…'; $('conn').dataset.ok = '0'; });
  socket.on('connect_error', err => {
    $('conn').textContent = err.message === 'unauthorized' ? 'Key or sign-in rejected' : 'Server offline'; $('conn').dataset.ok = '0';
    if (err.message === 'unauthorized' && auth.mode === 'key') log('The camera key was rejected. Use <b>Sign out</b> to enter it again.');
  });
}

/* ---------- snapshots: crop the primary object from the full-resolution source ---------- */
function snapshot(box) {
  const el = $('source').value === 'synthetic' ? srcCanvas : video;
  const W = el.videoWidth || el.width, H = el.videoHeight || el.height;
  if (!W || !H) return null;
  const b = box || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.max(0, b.x * W), sy = Math.max(0, b.y * H), sw = Math.min(W - sx, b.w * W), sh = Math.min(H - sy, b.h * H);
  if (sw < 2 || sh < 2) return null;
  const scale = Math.min(1, 480 / Math.max(sw, sh));
  snapCanvas.width = Math.round(sw * scale); snapCanvas.height = Math.round(sh * scale);
  snapCanvas.getContext('2d').drawImage(el, sx, sy, sw, sh, 0, 0, snapCanvas.width, snapCanvas.height);
  return snapCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

function sendEvent(ev) {
  if (ev.needs_snapshot) ev.snapshot = snapshot(ev.crop_box);
  if (!socket?.connected) { log(`<span class="lv ${ev.risk}">${ev.risk}</span> not sent (offline)`); return; }
  socket.emit('camera:event', ev, ack => {
    if (ack && !ack.ok) log(`rejected: ${ack.error}`);
  });
  $('sSent').textContent = ++sent;
  const what = ev.type === 'none' ? 'clear' : `${ev.flock_size > 1 ? `flock of ${ev.flock_size}` : ev.type} · ${ev.direction}`;
  log(`<span class="lv ${ev.risk}">${ev.risk}</span> ${what}${ev.snapshot ? ' · snapshot' : ''}`);
}

/* ---------- drawing ---------- */
function fitOverlay() {
  const r = overlay.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
}
// The picture is letterboxed inside the view (object-fit: contain); map normalized coords into it.
function frameRect() {
  const W = overlay.width, H = overlay.height;
  const el = $('source').value === 'synthetic' ? srcCanvas : video;
  const ar = (el.videoWidth || el.width || 4) / (el.videoHeight || el.height || 3);
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function draw(state) {
  const f = frameRect(), P = ([x, y]) => [f.x + x * f.w, f.y + y * f.h];
  ov.clearRect(0, 0, overlay.width, overlay.height);
  if (!running && !drawing) return;   // nothing to line up against until the video is showing
  const poly = drawing || corridor;
  if (poly.length > 1) {
    ov.beginPath(); poly.forEach((p, i) => ov[i ? 'lineTo' : 'moveTo'](...P(p))); if (!drawing) ov.closePath();
    ov.fillStyle = 'rgba(194,100,63,.16)'; if (!drawing) ov.fill();
    ov.setLineDash([8, 6]); ov.strokeStyle = 'rgba(242,140,90,.9)'; ov.lineWidth = 2; ov.stroke(); ov.setLineDash([]);
  }
  if (!state) return;
  ov.font = `600 ${Math.round(12 * (overlay.width / 700 + .6))}px system-ui`; ov.lineWidth = 2;
  for (const g of state.flocks || []) if (g.bbox) {
    const [x, y] = P([g.bbox.x, g.bbox.y]);
    ov.setLineDash([5, 4]); ov.strokeStyle = '#fff'; ov.strokeRect(x - 6, y - 6, g.bbox.w * f.w + 12, g.bbox.h * f.h + 12); ov.setLineDash([]);
    ov.fillStyle = '#fff'; ov.fillText(`flock of ${g.size}${g.eta_seconds != null ? ` · ${Math.round(g.eta_seconds)} s` : ''}`, x - 6, y - 12);
  }
  for (const t of state.tracks) {
    const c = COLORS[t.classification] || COLORS.unknown, [x, y] = P([t.bbox.x, t.bbox.y]);
    ov.strokeStyle = c; ov.strokeRect(x, y, Math.max(6, t.bbox.w * f.w), Math.max(6, t.bbox.h * f.h));
    if (t.trail.length > 1) { ov.beginPath(); t.trail.forEach((p, i) => ov[i ? 'lineTo' : 'moveTo'](...P(p))); ov.globalAlpha = .6; ov.stroke(); ov.globalAlpha = 1; }
    if (!t.is_flock) { ov.fillStyle = c; ov.fillText(`${t.classification}${t.flap_hz ? ` ${t.flap_hz} Hz` : ''}${t.eta_seconds != null ? ` · ${Math.round(t.eta_seconds)} s` : ''}`, x, y - 5); }
  }
}

function showState(st) {
  const lvl = st.risk.level, p = st.primary;
  for (const el of [$('risk'), $('banner')]) el.dataset.risk = lvl;
  $('riskLvl').textContent = lvl.toUpperCase();
  const what = !p ? 'Clear sky' : p.kind === 'audio' ? 'Drone heard, not seen' : `${p.size > 1 ? `Flock of ${p.size} ${p.classification}s` : p.classification}${p.heading ? ` · heading ${p.heading.name}` : ''}`;
  $('riskWhat').textContent = what; $('bannerText').textContent = what;
  $('riskWhy').textContent = (st.risk.reasons || []).join(' · ') || '—';
  $('sObjects').textContent = st.tracks.length;
  $('sEta').textContent = p && p.eta_seconds != null ? `${Math.round(p.eta_seconds)} s` : '—';
  $('sBearing').textContent = p && p.bearing_deg != null ? `${Math.round(p.bearing_deg)}°` : '—';
  $('sFlap').textContent = p && p.flap_hz ? `${p.flap_hz} Hz` : '—';
  $('sFps').textContent = st.stats.fps ? `${Math.round(st.stats.fps)} fps` : '—';
}

/* ---------- frame loop ---------- */
function loop() {
  if (!running) return;
  const synthetic = $('source').value === 'synthetic';
  const t = synthetic ? (performance.now() - t0) / 1000 : ['clip', 'demo'].includes($('source').value) ? video.currentTime : (performance.now() - t0) / 1000;
  if (synthetic) {
    const img = sky.render(t);
    srcCtx.putImageData(new ImageData(img.data, srcCanvas.width, srcCanvas.height), 0, 0);
    smallCtx.drawImage(srcCanvas, 0, 0, small.width, small.height);
  } else if (video.readyState >= 2) {
    smallCtx.drawImage(video, 0, 0, small.width, small.height);
  } else { rafId = requestAnimationFrame(loop); return; }
  if (mode() === 'stream') { streamFrame(t); if (!botState) draw(null); }
  else { const st = engine.process(smallCtx.getImageData(0, 0, small.width, small.height), t); draw(st); showState(st); }
  rafId = requestAnimationFrame(loop);
}

async function start() {
  $('start').disabled = true;
  try {
    const source = $('source').value;
    engine = new DetectionEngine();
    applyCamera();
    if (mode() === 'local') engine.on('event', sendEvent);
    botState = null; framesSent = 0; inFlight = false;
    video.hidden = source === 'synthetic'; srcCanvas.hidden = source !== 'synthetic';
    if (source === 'synthetic') {
      srcCanvas.width = 1280; srcCanvas.height = 960;
      sky = new SyntheticSky({ width: 1280, height: 960, scenario: $('scenario').value, seed: Math.floor(Math.random() * 1000) });
      if (sky.corridor?.length) corridor = sky.corridor;
    } else {
      if (source === 'clip') {
        const file = $('clip').files[0]; if (!file) throw new Error('Choose a video file first.');
        video.srcObject = null; video.src = URL.createObjectURL(file); video.loop = true;
      } else if (source === 'demo') {
        if (!$('demoClip').value) throw new Error('No demo clips found on this server.');
        video.srcObject = null; video.src = `/clips/${$('demoClip').value}`; video.loop = true;
        // On-device detection runs at full frame rate; streaming is capped near 15 fps, so keep the phone preset there.
        if (mode() === 'local' && $('tuning').value === 'phone_15fps') { $('tuning').value = 'laptop_30fps'; applyCamera(); sendConfig(); }
      } else {
        video.src = ''; video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      }
      await video.play();
    }
    engine.setCorridor(corridor); sendConfig();
    if (mode() === 'stream') { $('aiStatus').textContent = 'Streaming to the website. The server bot analyses the feed; the tower shows it live.'; document.querySelector('#sSent').previousSibling.textContent = 'Frames sent'; }
    const el = source === 'synthetic' ? srcCanvas : video;
    const ar = (el.videoWidth || el.width) / (el.videoHeight || el.height) || 4 / 3;
    small.width = 320; small.height = Math.round(320 / ar);
    $('empty').hidden = true; fitOverlay();
    if (mode() === 'local' && $('coco').getAttribute('aria-pressed') === 'true') await startCoco();
    t0 = performance.now(); running = true; $('start').textContent = 'Stop';
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    log(`started · ${source === 'synthetic' ? $('scenario').value.replace(/_/g, ' ') : source}`);
    rafId = requestAnimationFrame(loop);
  } catch (err) { log(`could not start: ${err.message}`); }
  $('start').disabled = false;
}

// Stream mode: send a JPEG frame at most STREAM_FPS times a second, and only after the server acknowledged the
// previous one, so a slow connection lowers the frame rate instead of building up a delay.
function streamFrame(t) {
  const now = performance.now();
  if (inFlight || now - lastSent < 1000 / STREAM_FPS || !socket?.connected) return;
  const el = $('source').value === 'synthetic' ? srcCanvas : video;
  const W = el.videoWidth || el.width, H = el.videoHeight || el.height; if (!W || !H) return;
  frameCanvas.width = Math.min(STREAM_W, W); frameCanvas.height = Math.round(frameCanvas.width * H / W);
  frameCtx.drawImage(el, 0, 0, frameCanvas.width, frameCanvas.height);
  inFlight = true; lastSent = now;
  frameCanvas.toBlob(async blob => {
    if (!blob || !socket?.connected) { inFlight = false; return; }
    const buf = await blob.arrayBuffer();
    socket.timeout(4000).emit('camera:frame', { t: +t.toFixed(3) }, buf, () => { inFlight = false; });
    $('sSent').textContent = ++framesSent;
  }, 'image/jpeg', 0.65);
}
// The server sends a compact state; reshape it to what draw() and showState() expect.
function fromCompact(c) {
  return { risk: { level: c.risk, reasons: c.reasons || [] }, primary: c.primary && { ...c.primary, heading: c.primary.heading ? { name: c.primary.heading } : null },
    tracks: c.tracks, flocks: c.flocks, stats: { fps: c.fps } };
}

function stop() {
  running = false; cancelAnimationFrame(rafId); coco?.stop();
  video.srcObject?.getTracks().forEach(tr => tr.stop());
  wakeLock?.release().catch(() => {}); wakeLock = null;
  $('start').textContent = 'Start'; log('stopped');
}
$('start').addEventListener('click', () => (running ? stop() : start()));
addEventListener('resize', fitOverlay);
document.addEventListener('visibilitychange', async () => { if (running && document.visibilityState === 'visible') { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} } });

/* ---------- corridor drawing ---------- */
$('drawCorridor').addEventListener('click', () => {
  drawing = []; overlay.classList.add('drawing'); $('corridorHint').textContent = 'Tap points around the runway approach, then double-tap (or press this button again) to finish.';
  $('drawCorridor').textContent = 'Finish corridor';
  $('drawCorridor').onclick = finishCorridor;
});
function finishCorridor() {
  if (drawing && drawing.length >= 3) { corridor = drawing; store.set('skysentry.corridor', JSON.stringify(corridor)); engine?.setCorridor(corridor); sendConfig(); log('corridor saved'); }
  drawing = null; overlay.classList.remove('drawing'); $('drawCorridor').textContent = 'Draw corridor'; $('drawCorridor').onclick = null;
  $('corridorHint').textContent = 'Corridor saved on this device. Draw again any time.';
  draw(engine?.state);
}
overlay.addEventListener('click', e => {
  if (!drawing) return;
  const r = overlay.getBoundingClientRect(), dpr = overlay.width / r.width, f = frameRect();
  const x = ((e.clientX - r.left) * dpr - f.x) / f.w, y = ((e.clientY - r.top) * dpr - f.y) / f.h;
  drawing.push([Math.min(1, Math.max(0, +x.toFixed(3))), Math.min(1, Math.max(0, +y.toFixed(3)))]);
  draw(engine?.state);
});
overlay.addEventListener('dblclick', () => drawing && finishCorridor());

/* ---------- COCO-SSD, microphone, simulated drone ---------- */
async function startCoco() {
  coco ??= new CocoVerifier(engine, { base: 'lite_mobilenet_v2' });
  coco.engine = engine;
  $('aiStatus').textContent = 'Loading COCO-SSD (a few seconds the first time)…';
  const info = await coco.load();
  coco.start($('source').value === 'synthetic' ? srcCanvas : video);
  $('aiStatus').textContent = `COCO-SSD ready (${info.backend}). It double-checks one tracked object about every second.`;
}
$('coco').addEventListener('click', async () => {
  const on = $('coco').getAttribute('aria-pressed') !== 'true';
  $('coco').setAttribute('aria-pressed', String(on));
  if (on && running) await startCoco().catch(err => { $('aiStatus').textContent = `COCO-SSD failed: ${err.message}`; });
  if (!on) coco?.stop();
});

let micTimer = null, micStream = null;
$('mic').addEventListener('click', async () => {
  const on = $('mic').getAttribute('aria-pressed') !== 'true';
  if (!on) { clearInterval(micTimer); micStream?.getTracks().forEach(t => t.stop()); $('mic').setAttribute('aria-pressed', 'false'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 4096;
    ctx.createMediaStreamSource(micStream).connect(an);
    const spec = new Float32Array(an.frequencyBinCount), hum = new HumDetector();
    micTimer = setInterval(() => { an.getFloatFrequencyData(spec); engine?.setAudioProbability(hum.update(spec, ctx.sampleRate), 'hum'); }, 120);
    $('mic').setAttribute('aria-pressed', 'true');
    $('aiStatus').textContent = 'Listening for a steady drone hum.';
  } catch (err) { $('aiStatus').textContent = `Microphone blocked: ${err.message}`; }
});
$('fakeDrone').addEventListener('click', () => {
  const on = $('fakeDrone').getAttribute('aria-pressed') !== 'true';
  $('fakeDrone').setAttribute('aria-pressed', String(on));
  engine?.simulateDroneSound(on);
});

draw(null);
connect().catch(err => { if (err.message !== 'wrong role') log(`sign-in failed: ${err.message}`); });
