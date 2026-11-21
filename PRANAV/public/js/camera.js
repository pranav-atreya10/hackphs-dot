// Only the webcam in stream mode reaches the server. Local previews run the detector here.
import { DetectionEngine, SyntheticSky, SCENARIOS, HumDetector, PRESETS, DroneAudioModel, startModelMic } from '/detection/index.js';
import { CocoVerifier } from '/detection/adapters/coco.js';
import { signIn, refreshSocketAuth } from '/js/auth.js';
import { DetectorStatus } from '/js/detector-status.mjs';
import { createCameraAudioTelemetry } from '/js/camera-audio-telemetry.mjs';

const $ = id => document.getElementById(id);
const video = $('video'), srcCanvas = $('src'), overlay = $('overlay');
const srcCtx = srcCanvas.getContext('2d'), ov = overlay.getContext('2d');
const small = document.createElement('canvas'), smallCtx = small.getContext('2d', { willReadFrequently: true });
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)', debris: '#a08c78' };

let engine = null, sky = null, coco = null, running = false, rafId = 0, t0 = 0, wakeLock = null;
let cocoTimer = null, cocoGeneration = 0, cocoLoad = null;
let activeSource = null, activeMode = null, generation = 0, starting = false, clipURL = null;
let draftMask = [], approvedMask = [], activeStreamId = '';
let drawing = null, socket = null, auth = null, inFlight = false, lastSent = 0, framesSent = 0, lastVideoTime = -1;
const detector = new DetectorStatus();
const frameCanvas = document.createElement('canvas'), frameCtx = frameCanvas.getContext('2d');
const STREAM_W = 640, STREAM_FPS = 15;
const ACOUSTIC_OFF_NOTE = 'Acoustic telemetry off · raw audio never leaves this browser.';

/* ---------- form state ---------- */
for (const [k, s] of Object.entries(SCENARIOS)) $('scenario').add(new Option(s.describe ? `${k.replace(/_/g, ' ')}: ${s.describe}` : k, k));
for (const id of ['cameraId', 'heading', 'fov', 'pitch', 'lat', 'lon']) {
  const saved = store.get('skysentry.' + id, null);
  if (saved !== null) $(id).value = saved;
  $(id).addEventListener('change', () => { store.set('skysentry.' + id, $(id).value); applyCamera(); sendConfig(); });
}
const requestedCameraId = new URLSearchParams(location.search).get('cameraId');
// Each device gets its own camera ID (kept in this browser), so two cameras never share one feed on the tower.
// "runway-east" used to be everyone's default, so a browser still holding it gets a fresh one too.
const savedId = store.get('skysentry.cameraId', '');
const savedDevice = store.get('skysentry.deviceId', '');
function browserDeviceId() {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedDevice)) return savedDevice;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
const deviceId = browserDeviceId();
store.set('skysentry.deviceId', deviceId);
$('cameraId').value = requestedCameraId?.slice(0, 60) || (savedId && savedId !== 'runway-east' ? savedId : `cam-${deviceId.slice(0, 8)}`);
store.set('skysentry.cameraId', $('cameraId').value);
const mode = () => activeMode || $('mode').value;
const live = () => running && activeSource === 'webcam';
const sendsFrames = () => live() && mode() === 'stream';
const audioTelemetry = typeof createCameraAudioTelemetry === 'function'
  ? createCameraAudioTelemetry({
      transport: 'socket',
      mediaDevices: typeof navigator !== 'undefined' ? navigator?.mediaDevices : undefined,
      AudioContext: typeof AudioContext === 'function' ? AudioContext : (typeof webkitAudioContext === 'function' ? webkitAudioContext : undefined),
      getSocket: () => (sendsFrames() && socket?.connected ? socket : null),
      isLiveStream: () => Boolean(sendsFrames() && socket?.connected),
      getSource: () => (sendsFrames() ? 'live' : 'local'),
      getStreamId: () => (sendsFrames() && socket?.connected ? (activeStreamId || deviceId) : ''),
      getTimestamp: () => (running ? +Math.max(0, (performance.now() - t0) / 1000).toFixed(3) : 0),
      onSummary: summary => {
        if (!audioTelemetry?.enabled) return;
        const pct = Math.round((summary.droneProb || 0) * 100);
        setAcousticUi(
          true,
          summary.humDetected
            ? `Sharing advisory summary · ${summary.dominantHz} Hz rotor hum (${pct}%) · no raw audio sent.`
            : 'Sharing advisory summary · mic on (no rotor hum) · raw audio never leaves this browser.',
        );
      },
    })
  : null;
function setAcousticUi(pressed, text = ACOUSTIC_OFF_NOTE) {
  $('acousticTelemetryBtn')?.setAttribute?.('aria-pressed', pressed ? 'true' : 'false');
  if ($('acousticTelemetryStatus')) $('acousticTelemetryStatus').textContent = text;
}
function stopAcousticTelemetry(text = ACOUSTIC_OFF_NOTE) {
  if (audioTelemetry) void audioTelemetry.disable();
  setAcousticUi(false, text);
}
$('mode').value = store.get('skysentry.mode', 'stream');
$('mode').addEventListener('change', () => {
  store.set('skysentry.mode', $('mode').value);
  if ($('mode').value !== 'stream') stopAcousticTelemetry();
  if (running || starting) stop();
});
function sendConfig() {
  approvedMask = [];
  activeStreamId = '';
  detector.reset();
  if (sendsFrames() && socket?.connected) socket.emit('camera:config', {
    source: 'live', cameraLabel: $('cameraId').value, camera: cameraConfig(), preset: [$('tuning').value],
  });
}
$('tuning').value = store.get('skysentry.tuning', 'phone_15fps');
$('tuning').addEventListener('change', () => { store.set('skysentry.tuning', $('tuning').value); applyCamera(); sendConfig(); });
// Demo clips shipped with the site (public/clips/clips.json).
fetch('/clips/clips.json').then(r => r.json()).then(list => {
  for (const c of list) $('demoClip').add(new Option(`${c.title} · ${c.expect}`, c.file));
  const requested = new URLSearchParams(location.search).get('demo');
  if (!running && !starting && requested && list.some(c => c.file === requested)) {
    $('demoClip').value = requested; $('source').value = 'demo'; showSourceFields();
    $('empty').textContent = 'Recorded demo selected. Press Start to run the detector on it.';
  }
}).catch(() => { $('source').querySelector('option[value="demo"]').disabled = true; });
const showSourceFields = () => { $('scenarioWrap').hidden = $('source').value !== 'synthetic'; $('clipWrap').hidden = $('source').value !== 'clip'; $('demoWrap').hidden = $('source').value !== 'demo'; };
$('source').addEventListener('change', () => {
  showSourceFields();
  if ($('source').value !== 'webcam') stopAcousticTelemetry();
  if (running || starting) stop();
});
// Every device starts on its own camera. The synthetic sky and demo clips stay in Settings / the Demos page.
$('source').value = 'webcam';
const requestedScenario = new URLSearchParams(location.search).get('scenario');
if (SCENARIOS[requestedScenario]) { $('source').value = 'synthetic'; $('scenario').value = requestedScenario; }
showSourceFields();

function cameraConfig() {
  return { lat: $('lat').valueAsNumber, lon: $('lon').valueAsNumber, heading_deg: $('heading').valueAsNumber,
    hfov_deg: $('fov').valueAsNumber, pitch_deg: $('pitch').valueAsNumber };
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
  // auth as a function so every reconnect gets a fresh sign-in token.
  socket = io('/camera', { auth: cb => auth.socketAuth({ deviceId }).then(cb) });
  refreshSocketAuth(socket, auth);
  socket.on('connect', () => { $('conn').textContent = 'Connected'; $('conn').dataset.ok = '1'; inFlight = false; sendConfig(); if (!running && !starting) status('Connected. Press Start.'); });
  socket.on('camera:config', cfg => {
    if (sendsFrames() && typeof cfg?.streamId === 'string' && cfg.streamId) activeStreamId = cfg.streamId;
    const pose = cameraConfig();
    approvedMask = sendsFrames() && cfg.surveyId && Array.isArray(cfg.corridor) &&
      Object.keys(pose).every(key => pose[key] === cfg.camera?.[key]) ? cfg.corridor : [];
  });
  socket.on('bot:state', result => {
    if (sendsFrames()) {
      if (typeof result?.streamId === 'string' && result.streamId) activeStreamId = result.streamId;
      detector.accept(result);
    }
  });
  socket.on('bot:status', result => { if (sendsFrames()) detector.update(result); });
  socket.on('disconnect', reason => {
    activeStreamId = '';
    stopAcousticTelemetry();
    detector.reset('unavailable', 'camera disconnected'); approvedMask = [];
    $('conn').textContent = reason === 'io server disconnect' ? 'Access ended' : 'Reconnecting…'; $('conn').dataset.ok = '0';
    status(reason === 'io server disconnect' ? 'Reload to reauthorize this camera.' : 'Lost the server, reconnecting automatically…');
  });
  socket.on('connect_error', err => {
    $('conn').textContent = err.message === 'unauthorized' ? 'Key or sign-in rejected' : 'Server offline'; $('conn').dataset.ok = '0';
    if (err.message === 'unauthorized' && auth.mode === 'key') {
      status('Camera key rejected. Use Change camera key to enter it again.');
      log('The camera key was rejected. Use <b>Change camera key</b> to enter it again.');
    } else status(err.message === 'unauthorized' ? 'Sign-in rejected. Sign out and reconnect.' : 'Cannot reach the server. Retrying automatically…');
  });
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
  const demoMask = sky?.corridor || [];
  const poly = drawing || (approvedMask.length ? approvedMask : demoMask.length ? demoMask : draftMask);
  if (poly.length > 1) {
    ov.beginPath(); poly.forEach((p, i) => ov[i ? 'lineTo' : 'moveTo'](...P(p))); if (!drawing) ov.closePath();
    ov.fillStyle = 'rgba(194,100,63,.16)'; if (!drawing) ov.fill();
    ov.setLineDash([8, 6]); ov.strokeStyle = 'rgba(242,140,90,.9)'; ov.lineWidth = 2; ov.stroke(); ov.setLineDash([]);
    if (!drawing) {   // name the shaded area so nobody has to guess what it is
      const [lx, ly] = P([Math.min(...poly.map(p => p[0])), Math.min(...poly.map(p => p[1]))]);
      const size = Math.round(11 * (overlay.width / 700 + .6));
      ov.font = `600 ${size}px system-ui`; ov.fillStyle = 'rgba(242,140,90,.95)';
      ov.fillText(poly === approvedMask ? 'Surveyed image-space mask' : poly === demoMask ? 'Demo mask' : 'Draft mask (inactive)', lx + 8, ly + 8 + size);
    }
  }
  if (!state) return;
  ov.font = `600 ${Math.round(12 * (overlay.width / 700 + .6))}px system-ui`; ov.lineWidth = 2;
  for (const g of state.flocks || []) if (g.bbox) {
    const [x, y] = P([g.bbox.x, g.bbox.y]);
    ov.setLineDash([5, 4]); ov.strokeStyle = '#fff'; ov.strokeRect(x - 6, y - 6, g.bbox.w * f.w + 12, g.bbox.h * f.h + 12); ov.setLineDash([]);
    ov.fillStyle = '#fff'; ov.fillText(`flock of ${g.size}${g.eta_basis && g.eta_seconds != null ? ` · mask entry ${Math.round(g.eta_seconds)} s` : ''}`, x - 6, y - 12);
  }
  for (const t of state.tracks) {
    const c = COLORS[t.classification] || COLORS.unknown, [x, y] = P([t.bbox.x, t.bbox.y]);
    ov.strokeStyle = c; ov.strokeRect(x, y, Math.max(6, t.bbox.w * f.w), Math.max(6, t.bbox.h * f.h));
    if (t.trail.length > 1) { ov.beginPath(); t.trail.forEach((p, i) => ov[i ? 'lineTo' : 'moveTo'](...P(p))); ov.globalAlpha = .6; ov.stroke(); ov.globalAlpha = 1; }
    if (!t.is_flock) { ov.fillStyle = c; ov.fillText(`${t.classification}${t.flap_hz ? ` ${t.flap_hz} Hz` : ''}${t.eta_basis && t.eta_seconds != null ? ` · mask entry ${Math.round(t.eta_seconds)} s` : ''}`, x, y - 5); }
  }
}

function showState(st) {
  const lvl = st.risk.level, p = st.primary;
  for (const el of [$('risk'), $('banner')]) el.dataset.risk = lvl;
  $('riskLvl').textContent = lvl.toUpperCase();
  const what = !p ? (sendsFrames() ? 'No detections in monitored video' : 'No detections in preview') : p.kind === 'audio' ? 'Drone heard, not seen' : `${p.size > 1 ? `Flock of ${p.size} ${p.classification}s` : p.classification}${p.heading ? ` · heading ${p.heading.name}` : ''}`;
  $('riskWhat').textContent = what;
  const wait = waitingMessage(st.motion ? { shake: st.motion.shake, learning: !st.motion.ready } : st);
  $('bannerText').textContent = wait || what;
  if (wait) $('banner').dataset.risk = 'wait';
  const where = !live() ? `Simulation (${activeSource}) · local only` : mode() !== 'stream' ? 'Detecting on this device'
    : `Streaming · ${framesSent} frames sent · bot on the server`;
  if (running) status(`${where} · ${st.tracks.length} object${st.tracks.length === 1 ? '' : 's'} in view`);
  $('riskWhy').textContent = (st.risk.reasons || []).join(' · ') || '—';
  $('sObjects').textContent = st.tracks.length;
  $('sEta').textContent = p?.eta_basis && p.eta_seconds != null ? `${Math.round(p.eta_seconds)} s` : '—';
  $('sBearing').textContent = p && p.bearing_deg != null ? `${Math.round(p.bearing_deg)}°` : '—';
  $('sFlap').textContent = p && p.flap_hz ? `${p.flap_hz} Hz` : '—';
  $('sFps').textContent = st.stats.fps ? `${Math.round(st.stats.fps)} fps` : '—';
}

/* ---------- frame loop ---------- */
function showWaiting() {
  draw(null);
  for (const el of [$('risk'), $('banner')]) el.dataset.risk = 'wait';
  $('riskLvl').textContent = 'UNKNOWN'; $('riskWhat').textContent = 'No fresh server result'; $('riskWhy').textContent = '—';
  for (const id of ['sObjects', 'sEta', 'sBearing', 'sFlap', 'sFps']) $(id).textContent = '—';
  $('bannerText').textContent = detector.message();
  status(`Streaming · ${framesSent} frames sent · ${$('bannerText').textContent}`);
}
function loop() {
  if (!running) return;
  const synthetic = activeSource === 'synthetic';
  const t = ['clip', 'demo'].includes(activeSource) ? video.currentTime : (performance.now() - t0) / 1000;
  if (synthetic) {
    const img = sky.render(t);
    srcCtx.putImageData(new ImageData(img.data, srcCanvas.width, srcCanvas.height), 0, 0);
    smallCtx.drawImage(srcCanvas, 0, 0, small.width, small.height);
  } else if (video.readyState >= 2) {
    smallCtx.drawImage(video, 0, 0, small.width, small.height);
  } else { if (mode() === 'stream') showWaiting(); next(); return; }
  if (sendsFrames()) streamFrame(t);
  if (mode() === 'stream') {
    const state = detector.current();
    // The local viewfinder is not the exact server frame; do not overlay its boxes here.
    if (state) { draw(null); showState(fromCompact(state)); }
    else showWaiting();
  } else {
    const st = engine.process(smallCtx.getImageData(0, 0, small.width, small.height), t); draw(st); showState(st);
  }
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
  if (running || starting) return;
  const gen = ++generation;
  const source = $('source').value;
  starting = true;
  $('start').textContent = 'Stop';
  activeSource = source;
  activeMode = source === 'webcam' ? $('mode').value : 'local';
  try {
    sky = null;
    engine = new DetectionEngine();
    applyCamera();
    detector.reset();
    framesSent = 0; inFlight = false; lastVideoTime = -1;
    video.hidden = source === 'synthetic'; srcCanvas.hidden = source !== 'synthetic';
    if (source === 'synthetic') {
      srcCanvas.width = 1280; srcCanvas.height = 960;
      sky = new SyntheticSky({ width: 1280, height: 960, scenario: $('scenario').value, seed: Math.floor(Math.random() * 1000) });
      engine.setCorridor(sky.corridor, { demo: true });
    } else {
      if (source === 'clip') {
        const file = $('clip').files[0]; if (!file) throw new Error('Choose a video file first.');
        clipURL = URL.createObjectURL(file);
        video.src = clipURL; video.loop = true;
      } else if (source === 'demo') {
        if (!$('demoClip').value) throw new Error('No demo clips found on this server.');
        // Browsers without H.264 (Chromium builds, some Linux Firefox) get the VP9 WebM copy of the same clip.
        const clip = $('demoClip').value, h264 = video.canPlayType('video/mp4; codecs="avc1.42E01E"');
        video.srcObject = null; video.src = `/clips/${h264 ? clip : clip.replace(/\.mp4$/, '.webm')}`; video.loop = true;
        // On-device detection runs at full frame rate; streaming is capped near 15 fps, so keep the phone preset there.
        if (mode() === 'local' && $('tuning').value === 'phone_15fps') { $('tuning').value = 'laptop_30fps'; applyCamera(); sendConfig(); }
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable here. Use HTTPS or localhost');
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (gen !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        video.srcObject = stream;
      }
      await video.play();
    }
    if (gen !== generation) return;
    t0 = performance.now(); starting = false; running = true; lastSent = 0;
    if (!sendsFrames()) stopAcousticTelemetry();
    sendConfig();
    if (mode() === 'stream') { $('aiStatus').textContent = 'The server checks video only; it does not check drone audio.'; }
    else { $('aiStatus').textContent = 'Local preview only. Nothing is sent to the tower.'; }
    $('sSent').textContent = '0';
    const el = source === 'synthetic' ? srcCanvas : video;
    const ar = (el.videoWidth || el.width) / (el.videoHeight || el.height) || 4 / 3;
    small.width = 320; small.height = Math.round(320 / ar);
    $('empty').hidden = true; fitOverlay();
    if (mode() === 'local' && $('coco').getAttribute('aria-pressed') === 'true') void startCoco().catch(err => { if (gen === generation) $('aiStatus').textContent = `Bird check unavailable: ${err.message}`; });
    if (mode() === 'stream') { $('banner').dataset.risk = 'wait'; $('bannerText').textContent = 'Waiting for the server bot…'; }
    status(!live() ? `Simulation (${source}) · local only` : !sendsFrames() ? 'Local camera preview' : socket?.connected ? 'Starting… keep the camera still for a few seconds' : 'Started, but not connected to the server yet. It will send as soon as it connects.');
    log(`started · ${source === 'synthetic' ? $('scenario').value.replace(/_/g, ' ') : source}`);
    rafId = requestAnimationFrame(loop); followVisibility();
    // Optional screen-awake permission must never hold up video or model startup.
    void requestWakeLock(gen);
  } catch (err) {
    if (gen !== generation) return;
    stop();
    log(`could not start: ${String(err.message).replace(/[<>&]/g, '')}`);
    if ($('source').value === 'webcam' && /NotAllowed|NotFound|NotReadable|Overconstrained|Security/.test(err.name)) {
      const why = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'Camera access was blocked. Allow it in the browser’s address bar and press Start again'
        : err.name === 'NotFoundError' ? 'This device has no camera' : 'The camera is busy in another app or tab';
      $('empty').textContent = `${why}, or use Upload a video.`; $('empty').hidden = false;
      status(`${why}.`);
    } else {
      // Every other failure (unplayable clip, missing file, model error) is shown, not just logged.
        const why = /no supported source|NotSupported|decode/i.test(`${err.name} ${err.message}`) ? 'This browser cannot play that video format. Try Chrome, or upload an MP4 or WebM' : err.message;
      $('empty').textContent = `Could not start: ${why}.`; $('empty').hidden = false;
      status(`Could not start: ${why}.`);
    }
  }
}

// Stream mode: send a JPEG frame at most STREAM_FPS times a second, and only after the server acknowledged the
// previous one, so a slow connection lowers the frame rate instead of building up a delay.
function streamFrame(t) {
  const now = performance.now();
  if (!sendsFrames() || inFlight || now - lastSent < 1000 / STREAM_FPS || !socket?.connected) return;
  const gen = generation, connection = socket.id;
  const el = video;
  // A paused or ended track can still leave a readable, frozen image in the video element.
  if (!el.srcObject?.getVideoTracks().some(track => track.readyState === 'live' && !track.muted && track.enabled)) return;
  if (el.currentTime <= lastVideoTime) return;
  const W = el.videoWidth || el.width, H = el.videoHeight || el.height; if (!W || !H) return;
  const scale = Math.min(1, STREAM_W / Math.max(W, H));
  frameCanvas.width = Math.round(W * scale); frameCanvas.height = Math.round(H * scale);
  frameCtx.drawImage(el, 0, 0, frameCanvas.width, frameCanvas.height);
  inFlight = true; lastSent = now; lastVideoTime = el.currentTime;
  frameCanvas.toBlob(async blob => {
    const current = () => gen === generation && sendsFrames() && socket?.connected && socket.id === connection;
    if (!current()) return;
    if (!blob) { inFlight = false; return; }
    try {
      const buf = await blob.arrayBuffer();
      if (!current()) return;
      socket.timeout(4000).emit('camera:frame', { source: 'live', t: +t.toFixed(3) }, buf, (err, ack) => {
        if (!current()) return;
        inFlight = false;
        if (!err && ack?.ok) {
          if (typeof ack.streamId === 'string' && ack.streamId) activeStreamId = ack.streamId;
          framesSent++;
          $('sSent').textContent = framesSent;
        } else detector.reset('unavailable', 'camera frame not accepted');
      });
    } catch (err) {
      if (current()) { inFlight = false; console.warn('Could not encode camera frame', err); }
    }
  }, 'image/jpeg', 0.65);
}
// The server sends a compact state; reshape it to what draw() and showState() expect.
function fromCompact(c) {
  return { risk: { level: c.risk, reasons: c.reasons || [] }, primary: c.primary && { ...c.primary, heading: c.primary.heading ? { name: c.primary.heading } : null },
    tracks: c.tracks, flocks: c.flocks, stats: { fps: c.fps }, shake: c.shake, learning: c.learning };
}

function stop() {
  if (sendsFrames() && socket?.connected) socket.emit('camera:stop');
  generation++;
  running = starting = false; activeSource = activeMode = null;
  sky = null; approvedMask = []; activeStreamId = ''; detector.reset();
  cancelAnimationFrame(rafId); ticker.postMessage(0); stopCoco(); stopMic(); stopAcousticTelemetry();
  video.srcObject?.getTracks().forEach(tr => tr.stop());
  video.pause();
  video.srcObject = null; video.removeAttribute('src'); video.load();
  if (clipURL) { URL.revokeObjectURL(clipURL); clipURL = null; }
  wakeLock?.release().catch(() => {}); wakeLock = null;
  // Back to the idle look: no frozen frame or corridor left behind, and the hint shows again.
  ov.clearRect(0, 0, overlay.width, overlay.height); srcCtx.clearRect(0, 0, srcCanvas.width, srcCanvas.height); video.hidden = true; srcCanvas.hidden = true;
  $('empty').textContent = 'Stopped. Press Start to go again.'; $('empty').hidden = false;
  $('start').textContent = 'Start'; log('stopped'); status('Stopped.'); $('banner').dataset.risk = 'wait'; $('bannerText').textContent = 'Ready';
  $('risk').dataset.risk = 'wait'; $('riskLvl').textContent = 'UNKNOWN'; $('riskWhat').textContent = 'Stopped'; $('riskWhy').textContent = '—';
  $('fakeDrone').setAttribute('aria-pressed', 'false');
}
$('start').addEventListener('click', () => (running || starting ? stop() : start()));
// Uploaded video is a local simulation, not a tower feed.
$('upload').addEventListener('click', () => $('uploadFile').click());
$('uploadFile').addEventListener('change', async () => {
  const file = $('uploadFile').files[0]; if (!file) return;
  const files = new DataTransfer(); files.items.add(file); $('clip').files = files.files;   // the Settings field start() reads
  $('source').value = 'clip'; showSourceFields();
  $('uploadFile').value = '';
  if (running || starting) stop();
  log(`video chosen: ${file.name.replace(/[<>&]/g, '')}`);
  await start();
});
addEventListener('resize', fitOverlay);
async function requestWakeLock(gen) {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    if (!running || gen !== generation || (wakeLock && !wakeLock.released)) await lock.release();
    else wakeLock = lock;
  } catch { /* Screen-awake permission is optional. */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') void requestWakeLock(generation); });
addEventListener('pagehide', stop);

/* ---------- corridor drawing ---------- */
$('drawCorridor').addEventListener('click', () => {
  if (drawing) { finishCorridor(); return; }
  drawing = []; overlay.classList.add('drawing'); $('corridorHint').textContent = 'Tap points for a draft mask, then double-tap (or press this button again) to finish.';
  $('drawCorridor').textContent = 'Finish corridor';
});
function finishCorridor() {
  if (drawing && drawing.length >= 3) { draftMask = drawing; log('draft mask previewed; not active'); }
  drawing = null; overlay.classList.remove('drawing'); $('drawCorridor').textContent = 'Draw corridor';
  $('corridorHint').textContent = 'Draft preview only. A site-approved survey must be configured on the server.';
  draw(mode() === 'stream' ? null : engine?.state);
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
function stopCoco() {
  cocoGeneration++;
  clearTimeout(cocoTimer);
  cocoTimer = null;
}
async function startCoco() {
  stopCoco();
  const gen = cocoGeneration, target = engine;
  const current = () => gen === cocoGeneration && running && $('coco').getAttribute('aria-pressed') === 'true';
  coco ??= new CocoVerifier(null, { base: 'lite_mobilenet_v2' });
  $('aiStatus').textContent = 'Loading COCO-SSD (a few seconds the first time)…';
  try {
    cocoLoad ??= coco.load().catch(err => { cocoLoad = null; throw err; });
    const info = await cocoLoad;
    if (!current()) return;
    const check = async () => {
      if (!current()) return;
      if (!coco.busy) {
        coco.source = activeSource === 'synthetic' ? srcCanvas : video;
        coco.engine = {
          cocoCandidates: (...args) => current() ? target.cocoCandidates(...args) : [],
          applyLabel: (...args) => { if (current()) target.applyLabel(...args); },
        };
        await coco.tick();
      }
      if (current()) cocoTimer = setTimeout(check, info.intervalMs);
    };
    cocoTimer = setTimeout(check, info.intervalMs);
    $('aiStatus').textContent = `COCO-SSD ready (${info.backend}). It double-checks one tracked object about every second.`;
  } catch (err) {
    if (current()) $('aiStatus').textContent = `Bird check unavailable: ${err.message}`;
  }
}
$('coco').addEventListener('click', async () => {
  const on = $('coco').getAttribute('aria-pressed') !== 'true';
  $('coco').setAttribute('aria-pressed', String(on));
  if (on && running && mode() === 'local') await startCoco();
  if (!on) stopCoco();
});

let micTimer = null, micStream = null, micStop = null, audioModel = null, micGeneration = 0;
function stopMic() {
  micGeneration++;
  clearInterval(micTimer); micTimer = null;
  if (micStop) Promise.resolve().then(micStop).catch(err => console.warn('Could not close microphone audio context', err));
  micStop = null;
  micStream?.getTracks().forEach(track => track.stop()); micStream = null;
  engine?.setAudioProbability(0, 'hum');
  $('mic').setAttribute('aria-pressed', 'false');
}
$('mic').addEventListener('click', async () => {
  const on = $('mic').getAttribute('aria-pressed') !== 'true';
  if (!on) { stopMic(); return; }
  if (!running) { $('aiStatus').textContent = 'Start the camera preview before turning on the microphone.'; return; }
  const gen = ++micGeneration;
  const target = engine;
  const current = () => gen === micGeneration && running;
  $('mic').setAttribute('aria-pressed', 'true');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
    micStream = stream;
    // Trained drone-sound model first (99% of test drones, 0.4% false alarms); the hum rule is the fallback.
    try {
      audioModel ??= await DroneAudioModel.load('/detection/models/drone_audio_v0.json');
      if (!current()) return;
      const close = await startModelMic(stream, { setAudioProbability: (...args) => { if (current()) target.setAudioProbability(...args); } }, audioModel);
      if (!current()) { await close(); return; }
      micStop = close;
      $('aiStatus').textContent = 'Listening with the trained drone-sound model.';
    } catch (err) {
      if (!current()) return;
      const ctx = new AudioContext();
      micStop = () => ctx.close();
      const an = ctx.createAnalyser(); an.fftSize = 4096;
      ctx.createMediaStreamSource(stream).connect(an);
      const spec = new Float32Array(an.frequencyBinCount), hum = new HumDetector();
      micTimer = setInterval(() => { if (current()) { an.getFloatFrequencyData(spec); target.setAudioProbability(hum.update(spec, ctx.sampleRate), 'hum'); } }, 120);
      $('aiStatus').textContent = `Listening for a steady drone hum (model unavailable: ${err.message}).`;
    }
  } catch (err) { if (current()) { stopMic(); $('aiStatus').textContent = `Microphone blocked: ${err.message}`; } }
});
$('fakeDrone').addEventListener('click', () => {
  if (!running || live()) { $('aiStatus').textContent = 'Simulated drone sound is available only in a local demo.'; return; }
  const on = $('fakeDrone').getAttribute('aria-pressed') !== 'true';
  $('fakeDrone').setAttribute('aria-pressed', String(on));
  engine?.simulateDroneSound(on);
});
$('acousticTelemetryBtn')?.addEventListener?.('click', async () => {
  const wantOn = $('acousticTelemetryBtn').getAttribute('aria-pressed') !== 'true';
  if (!wantOn) { stopAcousticTelemetry(); return; }
  if (!sendsFrames() || !socket?.connected) {
    setAcousticUi(false, 'Start live webcam streaming while connected to the server before sharing rotor-hum telemetry.');
    return;
  }
  if (!audioTelemetry) {
    setAcousticUi(false, 'Acoustic telemetry is unavailable in this browser.');
    return;
  }
  const gen = generation;
  setAcousticUi(true, 'Requesting microphone for local spectral summary…');
  const res = await audioTelemetry.enable();
  if (!res?.ok || gen !== generation || !sendsFrames() || !socket?.connected) {
    stopAcousticTelemetry(
      res?.reason === 'NotAllowedError' || res?.reason === 'SecurityError'
        ? 'Microphone permission blocked · acoustic telemetry remains off.'
        : !sendsFrames() || !socket?.connected
          ? ACOUSTIC_OFF_NOTE
          : `Acoustic telemetry unavailable (${res?.reason || 'microphone error'}).`,
    );
    return;
  }
  setAcousticUi(true, 'Sharing advisory summary · mic on · raw audio never leaves this browser.');
});

draw(null);
connect().catch(err => {
  $('conn').textContent = 'Sign-in needs attention';
  status(err.message === 'wrong role' ? 'Use a camera account to connect this page.' : `Could not connect: ${err.message}`);
  if (err.message !== 'wrong role') log(`sign-in failed: ${err.message}`);
});
