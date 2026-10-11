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
const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)', debris: '#a08c78' };

let engine = null, sky = null, coco = null, running = false, rafId = 0, t0 = 0, sent = 0, wakeLock = null;
let corridor = JSON.parse(store.get('skysentry.corridor', 'null')) || WEBCAM_CORRIDOR;
let drawing = null, socket = null, auth = null, botState = null, streaming = false, inFlight = false, lastSent = 0, framesSent = 0;
// Stream mode: if the server bot sends nothing back for this long (it hands over when the server is too slow),
// this device runs the detector itself so the screen still shows boxes and risk. Alerts still come from the server.
const BOT_STALE_MS = 3000;
let lastBotAt = 0, botReason = null;
const frameCanvas = document.createElement('canvas'), frameCtx = frameCanvas.getContext('2d');
const STREAM_W = 640, STREAM_FPS = 15;

/* ---------- form state ---------- */
for (const [k, s] of Object.entries(SCENARIOS)) $('scenario').add(new Option(s.describe ? `${k.replace(/_/g, ' ')}: ${s.describe}` : k, k));
for (const id of ['cameraId', 'heading', 'fov', 'lat', 'lon']) {
  const saved = store.get('skysentry.' + id, null);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener('change', () => { store.set('skysentry.' + id, $(id).value); applyCamera(); sendConfig(); });
}
const requestedCameraId = new URLSearchParams(location.search).get('cameraId');
// Each device gets its own camera ID (kept in this browser), so two cameras never share one feed on the tower.
// "runway-east" used to be everyone's default, so a browser still holding it gets a fresh one too.
const savedId = store.get('skysentry.cameraId', '');
$('cameraId').value = requestedCameraId?.slice(0, 60) || (savedId && savedId !== 'runway-east' ? savedId : `cam-${Math.random().toString(36).slice(2, 6)}`);
store.set('skysentry.cameraId', $('cameraId').value);
const mode = () => $('mode').value;
$('mode').value = store.get('skysentry.mode', 'stream');
$('mode').addEventListener('change', () => store.set('skysentry.mode', mode()));
function sendConfig() { socket?.connected && socket.emit('camera:config', { camera: cameraConfig(), corridor, preset: [$('tuning').value] }); }
$('tuning').value = store.get('skysentry.tuning', 'phone_15fps');
$('tuning').addEventListener('change', () => { store.set('skysentry.tuning', $('tuning').value); applyCamera(); sendConfig(); });
// Demo clips shipped with the site (public/clips/clips.json).
fetch('/clips/clips.json').then(r => r.json()).then(list => {
  for (const c of list) $('demoClip').add(new Option(`${c.title} · ${c.expect}`, c.file));
  const requested = new URLSearchParams(location.search).get('demo');
  if (requested && list.some(c => c.file === requested)) {
    $('demoClip').value = requested; $('source').value = 'demo'; showSourceFields();
    $('empty').textContent = 'Recorded demo selected. Press Start to run the detector on it.';
  }
}).catch(() => { $('source').querySelector('option[value="demo"]').disabled = true; });
const showSourceFields = () => { $('scenarioWrap').hidden = $('source').value !== 'synthetic'; $('clipWrap').hidden = $('source').value !== 'clip'; $('demoWrap').hidden = $('source').value !== 'demo'; };
$('source').addEventListener('change', showSourceFields);
// Every device starts on its own camera. The synthetic sky and demo clips stay in Settings / the Demos page.
$('source').value = 'webcam';
const requestedScenario = new URLSearchParams(location.search).get('scenario');
if (SCENARIOS[requestedScenario]) { $('source').value = 'synthetic'; $('scenario').value = requestedScenario; }
showSourceFields();

function cameraConfig() {
  return { lat: +$('lat').value, lon: +$('lon').value, heading_deg: +$('heading').value, hfov_deg: +$('fov').value };
}
function applyCamera() {
  if (!engine) return;
  engine.setConfig({ camera_id: $('cameraId').value.trim() || 'runway-east', camera: cameraConfig() });
  if (PRESETS[$('tuning').value]) engine.setConfig(PRESETS[$('tuning').value]);
}

const status = text => { $('statusLine').textContent = text; };
function waitingMessage(st) {
  if (st?.shake) return 'Hold the camera still: it’s moving, so the bot is paused';
  if (st?.learning) return 'Learning the sky… keep the camera still for a few seconds';
  return null;
}

function log(html) {
  const li = document.createElement('li'); li.innerHTML = `${new Date().toLocaleTimeString()} ${html}`;
  $('log').prepend(li); while ($('log').children.length > 40) $('log').lastChild.remove();
}

/* ---------- QR code: open this page on a phone ---------- */
// Laptops show a QR code so a phone can become the camera; phones already are one. The QR never carries a camera key.
if (/Android|iPhone|iPad/i.test(navigator.userAgent)) $('phoneQr').hidden = true;
else {
  const camUrl = `${location.origin}/camera.html`;
  $('camUrl').textContent = camUrl;
  try { const qr = qrcode(0, 'M'); qr.addData(camUrl); qr.make(); $('qr').innerHTML = qr.createImgTag(4, 0, 'QR code that opens the SkySentry camera page on a phone'); }
  catch { $('phoneQr').hidden = true; }
  if (location.protocol !== 'https:' && !/^(localhost|127\.)/.test(location.hostname)) $('camUrl').textContent += ' (phones need https for the camera; use the deployed site)';
}

/* ---------- connection to the server ---------- */
async function connect() {
  $('signout').disabled = true;
  auth = await signIn({ role: 'camera', mount: $('auth'), demo: new URLSearchParams(location.search).has('demo'), onStatus: message => {
    $('conn').textContent = message;
    status(message === 'Camera key needed' ? 'Enter the camera key above, then press Connect.' : 'Sign in above to connect this camera.');
  } });
  $('conn').textContent = 'Connecting…';
  $('signout').disabled = false;
  $('signout').textContent = auth.mode === 'key' ? 'Change camera key' : 'Sign out';
  $('signout').onclick = () => auth.signOut();
  if (auth.changeAirport) {   // admins running a camera: switch which airport it reports to
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'linkbtn', textContent: 'Change airport' });
    b.onclick = auth.changeAirport; $('signout').before(b);
  }
  // auth as a function so every reconnect gets a fresh sign-in token.
  socket = io('/camera', { auth: cb => auth.socketAuth({ cameraId: $('cameraId').value.trim() || 'runway-east' }).then(cb) });
  // The server renames this camera if another device is already streaming under the same ID.
  socket.on('camera:id', id => { if (id && id !== $('cameraId').value) { log(`another camera already uses that ID, so this one is <b>${String(id).replace(/[<>&]/g, '')}</b>`); $('cameraId').value = id; store.set('skysentry.cameraId', id); } });
  socket.on('connect', () => { $('conn').textContent = 'Connected'; $('conn').dataset.ok = '1'; inFlight = false; sendConfig(); if (!running) status('Connected. Press Start.'); });
  // In stream mode the server's bot sends back what it sees, so the phone shows the same boxes as the tower.
  socket.on('bot:state', ({ state }) => { if (mode() === 'stream' && running) { lastBotAt = performance.now(); botState = fromCompact(state); draw(botState); showState(botState); } });
  socket.on('bot:status', s => { botReason = s.mode === 'server' ? null : s.reason; if (mode() === 'stream') $('aiStatus').textContent = s.mode === 'server' ? 'The server bot is analysing this feed.' : `Server bot unavailable (${s.reason}); a tower screen is analysing the feed instead.`; });
  socket.on('disconnect', () => { $('conn').textContent = 'Reconnecting…'; $('conn').dataset.ok = '0'; status('Lost the server, reconnecting automatically…'); });
  socket.on('connect_error', err => {
    $('conn').textContent = err.message === 'unauthorized' ? 'Key or sign-in rejected' : 'Server offline'; $('conn').dataset.ok = '0';
    if (err.message === 'unauthorized' && auth.mode === 'key') {
      status('Camera key rejected. Use Change camera key to enter it again.');
      log('The camera key was rejected. Use <b>Change camera key</b> to enter it again.');
    } else status(err.message === 'unauthorized' ? 'Sign-in rejected. Sign out and reconnect.' : 'Cannot reach the server. Retrying automatically…');
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
    if (!drawing) {   // name the shaded area so nobody has to guess what it is
      const [lx, ly] = P([Math.min(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1]))]);
      const size = Math.round(11 * (overlay.width / 700 + .6));
      ov.font = `600 ${size}px system-ui`; ov.fillStyle = 'rgba(242,140,90,.95)'; ov.fillText('Runway corridor', lx + 8, ly + 8 + size);
    }
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

function showState(st, onDevice = false) {
  const lvl = st.risk.level, p = st.primary;
  for (const el of [$('risk'), $('banner')]) el.dataset.risk = lvl;
  $('riskLvl').textContent = lvl.toUpperCase();
  const what = !p ? 'Clear sky' : p.kind === 'audio' ? 'Drone heard, not seen' : `${p.size > 1 ? `Flock of ${p.size} ${p.classification}s` : p.classification}${p.heading ? ` · heading ${p.heading.name}` : ''}`;
  $('riskWhat').textContent = what;
  const wait = waitingMessage(st.motion ? { shake: st.motion.shake, learning: !st.motion.ready } : st);
  $('bannerText').textContent = wait || what;
  if (wait) $('banner').dataset.risk = 'wait';
  const where = mode() !== 'stream' ? 'Detecting on this device'
    : onDevice ? `Streaming · ${framesSent} frames sent · server bot not responding${botReason ? ` (${botReason})` : ''}, so this device is checking`
    : `Streaming · ${framesSent} frames sent · bot on the server`;
  if (running) status(`${where} · ${st.tracks.length} object${st.tracks.length === 1 ? '' : 's'} in view`);
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
  } else { next(); return; }
  const now = performance.now();
  if (mode() === 'stream') streamFrame(t);
  if (mode() === 'stream' && now - lastBotAt < BOT_STALE_MS) { /* the bot:state handler draws */ }
  else if (mode() === 'stream' && now - t0 < BOT_STALE_MS) draw(null);   // give the server bot a moment first
  else { const st = engine.process(smallCtx.getImageData(0, 0, small.width, small.height), t); draw(st); showState(st, mode() === 'stream'); }
  next();
}
// Visible tab: animation frames. Hidden tab (e.g. you switched to the tower): the worker's ticks drive loop() at
// ~15 fps, since browsers pause requestAnimationFrame in background tabs and the stream would stop.
const ticker = new Worker('/js/tick-worker.js');
ticker.onmessage = () => { if (running && document.hidden) loop(); };
function next() { if (!document.hidden) rafId = requestAnimationFrame(loop); }
function followVisibility() {
  ticker.postMessage(running && document.hidden ? 66 : 0);
  if (running && !document.hidden) { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(loop); }
}
document.addEventListener('visibilitychange', followVisibility);

async function start() {
  $('start').disabled = true;
  try {
    const source = $('source').value;
    engine = new DetectionEngine();
    applyCamera();
    if (mode() === 'local') engine.on('event', sendEvent);
    botState = null; framesSent = 0; inFlight = false; lastBotAt = 0; botReason = null;
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
    if (mode() === 'local' && $('coco').getAttribute('aria-pressed') === 'true') void startCoco().catch(err => { $('aiStatus').textContent = `Bird check unavailable: ${err.message}`; });
    t0 = performance.now(); running = true; $('start').textContent = 'Stop';
    if (mode() === 'stream') { $('banner').dataset.risk = 'wait'; $('bannerText').textContent = 'Waiting for the server bot…'; }
    status(socket?.connected ? 'Starting… keep the camera still for a few seconds' : 'Started, but not connected to the server yet. It will send as soon as it connects.');
    log(`started · ${source === 'synthetic' ? $('scenario').value.replace(/_/g, ' ') : source}`);
    rafId = requestAnimationFrame(loop); followVisibility();
    // Optional screen-awake permission must never hold up video or model startup.
    try { navigator.wakeLock?.request('screen').then(lock => { if (running) wakeLock = lock; else lock.release().catch(() => {}); }).catch(() => {}); } catch {}
  } catch (err) {
    log(`could not start: ${err.message}`);
    if ($('source').value === 'webcam' && /NotAllowed|NotFound|NotReadable|Overconstrained|Security/.test(err.name)) {
      const why = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'Camera access was blocked. Allow it in the browser’s address bar and press Start again'
        : err.name === 'NotFoundError' ? 'This device has no camera' : 'The camera is busy in another app or tab';
      $('empty').textContent = `${why}, or use Upload a video.`; $('empty').hidden = false;
      status(`${why}.`);
    }
  }
  $('start').disabled = false;
}

// Stream mode: send a JPEG frame at most STREAM_FPS times a second, and only after the server acknowledged the
// previous one, so a slow connection lowers the frame rate instead of building up a delay.
function streamFrame(t) {
  const now = performance.now();
  if (inFlight || now - lastSent < 1000 / STREAM_FPS || !socket?.connected) return;
  const el = $('source').value === 'synthetic' ? srcCanvas : video;
  const W = el.videoWidth || el.width, H = el.videoHeight || el.height; if (!W || !H) return;
  const scale = Math.min(1, STREAM_W / Math.max(W, H));
  frameCanvas.width = Math.round(W * scale); frameCanvas.height = Math.round(H * scale);
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
    tracks: c.tracks, flocks: c.flocks, stats: { fps: c.fps }, shake: c.shake, learning: c.learning };
}

function stop() {
  running = false; cancelAnimationFrame(rafId); ticker.postMessage(0); coco?.stop();
  video.srcObject?.getTracks().forEach(tr => tr.stop());
  video.pause();
  wakeLock?.release().catch(() => {}); wakeLock = null;
  // Back to the idle look: no frozen frame or corridor left behind, and the hint shows again.
  ov.clearRect(0, 0, overlay.width, overlay.height); srcCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height); video.hidden = true; srcCanvas.hidden = true;
  $('empty').textContent = 'Stopped. Press Start to go again.'; $('empty').hidden = false;
  $('start').textContent = 'Start'; log('stopped'); status('Stopped.'); $('banner').dataset.risk = 'green'; $('bannerText').textContent = 'Ready';
}
$('start').addEventListener('click', () => (running ? stop() : start()));
// Demo: play a video from this computer through the detector (and stream it to the tower) instead of a live camera.
$('upload').addEventListener('click', () => $('uploadFile').click());
$('uploadFile').addEventListener('change', async () => {
  const file = $('uploadFile').files[0]; if (!file) return;
  const files = new DataTransfer(); files.items.add(file); $('clip').files = files.files;   // the Settings field start() reads
  $('source').value = 'clip'; showSourceFields();
  $('uploadFile').value = '';
  if (running) stop();
  log(`video chosen: ${file.name.replace(/[<>&]/g, '')}`);
  await start();
});
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
connect().catch(err => {
  $('conn').textContent = 'Sign-in needs attention';
  status(err.message === 'wrong role' ? 'Use a camera account to connect this page.' : `Could not connect: ${err.message}`);
  if (err.message !== 'wrong role') log(`sign-in failed: ${err.message}`);
});
