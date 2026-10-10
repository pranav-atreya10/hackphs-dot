// Tower dashboard: listens on this server's /tower namespace (Pranav's relay) for Vivan's contract events,
// shows risk, map pins from each camera's bearing, the hourly chart and incident reports, plays alerts,
// and drives the Arduino beacon through Vivan's BeaconLink (or the on-screen VirtualBeacon).
import { signIn } from '/js/auth.js';
import { BeaconLink, VirtualBeacon, encodeBeacon } from '/detection/adapters/beacon.js';

const $ = id => document.getElementById(id);
const RANK = { green: 0, yellow: 1, red: 2 };
const time = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
let auth = null, socket = null, soundOn = false, audioCtx = null;

/* ---------- phone camera QR ---------- */
const camUrl = `${location.origin}/camera.html`;
$('camUrl').textContent = camUrl;
try { const qr = qrcode(0, 'M'); qr.addData(camUrl); qr.make(); $('qr').innerHTML = qr.createImgTag(4, 0); } catch { $('qr').hidden = true; }
if (location.protocol !== 'https:' && !/^(localhost|127\.)/.test(location.hostname)) $('camUrl').textContent += ' (phones need https for the camera; use the deployed site)';

/* ---------- sound: alarm, then ElevenLabs audio from the server or the browser's voice ---------- */
$('sound').addEventListener('click', () => {
  soundOn = !soundOn; $('sound').textContent = soundOn ? 'Alert sound on' : 'Turn on alert sound';
  $('sound').setAttribute('aria-pressed', String(soundOn));
  if (soundOn) { audioCtx ??= new AudioContext(); audioCtx.resume(); }
});
function alarm() {
  if (!soundOn || !audioCtx) return Promise.resolve();
  const t = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t + i * .28); g.gain.exponentialRampToValueAtTime(.12, t + i * .28 + .02); g.gain.exponentialRampToValueAtTime(.0001, t + i * .28 + .24);
    o.connect(g).connect(audioCtx.destination); o.start(t + i * .28); o.stop(t + i * .28 + .26);
  }
  return new Promise(r => setTimeout(r, 900));
}
async function announce({ text, audio }) {
  $('alertText').textContent = text;
  await alarm();
  if (!soundOn) return;
  if (audio) return void new Audio(`data:audio/mpeg;base64,${audio}`).play().catch(() => {});
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.rate = .95; speechSynthesis.speak(u); }
}

/* ---------- risk across all cameras (each camera's latest event, for 10 s) ---------- */
const latest = new Map();
function describe(ev) {
  if (!ev || ev.risk === 'green' || ev.type === 'none') return 'Clear sky';
  if (ev.direction === 'heard, not seen') return 'Drone heard, not seen';
  const n = ev.flock_size || ev.object_count;
  return `${n > 1 ? `Flock of ${n} ${ev.type}s` : ev.type === 'unknown' ? 'Unknown object' : `One ${ev.type}`} · ${ev.direction}`;
}
function refreshRisk() {
  const now = Date.now();
  let top = null;
  for (const ev of latest.values()) if (now - ev.receivedAt < 10000 && (!top || RANK[ev.risk] > RANK[top.risk])) top = ev;
  const lvl = top?.risk || 'green';
  $('risk').dataset.risk = lvl; $('riskLvl').textContent = lvl.toUpperCase();
  $('riskWhat').textContent = describe(top);
  $('riskWhy').textContent = top ? `${top.cameraId} · ${time(top.receivedAt)}${top.eta_seconds != null ? ` · ${Math.round(top.eta_seconds)} s to corridor` : ''}${top.reasons?.length ? ' · ' + top.reasons.join(', ') : ''}` : 'No recent camera events';
}
setInterval(refreshRisk, 1000);

/* ---------- map: camera markers + field-of-view cones, threat pins and paths ---------- */
const map = L.map('map', { scrollWheelZoom: false }).setView([40.3987, -74.6586], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const camLayers = new Map(), pins = L.layerGroup().addTo(map);
let centered = false;
const dest = (lat, lon, brg, m) => { const b = brg * Math.PI / 180; return [lat + m * Math.cos(b) / 111320, lon + m * Math.sin(b) / (111320 * Math.cos(lat * Math.PI / 180))]; };
function placeCamera(ev) {
  const c = ev.camera; if (!c || c.lat == null) return;
  const key = ev.cameraId, cone = [[c.lat, c.lon]];
  for (let a = -c.hfov_deg / 2; a <= c.hfov_deg / 2; a += c.hfov_deg / 10) cone.push(dest(c.lat, c.lon, c.heading_deg + a, 400));
  camLayers.get(key)?.remove();
  camLayers.set(key, L.layerGroup([
    L.polygon(cone, { color: '#1f6fd1', weight: 1, fillOpacity: .08 }),
    L.circleMarker([c.lat, c.lon], { radius: 7, color: '#1f6fd1', fillOpacity: 1 }).bindTooltip(`Camera ${key}`)
  ]).addTo(map));
  if (!centered) { map.setView([c.lat, c.lon], 16); centered = true; }
}
function pin(ev) {
  if (!ev.target_geo || ev.risk === 'green') return;
  const [lon, lat] = ev.target_geo.coordinates, color = ev.risk === 'red' ? '#c0392b' : '#d99a00';
  L.circleMarker([lat, lon], { radius: 8, color, fillOpacity: .85 }).bindPopup(`<b>${describe(ev)}</b><br>${time(ev.receivedAt)} · ${ev.cameraId}`).addTo(pins);
  if (ev.path_geo?.coordinates?.length > 1) L.polyline(ev.path_geo.coordinates.map(([x, y]) => [y, x]), { color, weight: 2, opacity: .6, dashArray: '4 4' }).addTo(pins);
  while (pins.getLayers().length > 60) pins.removeLayer(pins.getLayers()[0]);
}

/* ---------- live feed ---------- */
function feed(ev) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${time(ev.receivedAt)}</span><span class="lv ${ev.risk}">${ev.risk}</span><span></span>`;
  li.lastChild.textContent = `${ev.cameraId} · ${describe(ev)}`;
  $('feed').prepend(li); while ($('feed').children.length > 80) $('feed').lastChild.remove();
}

/* ---------- beacon: Vivan's protocol to the Arduino, mirrored on screen ---------- */
const virtual = new VirtualBeacon($('beaconView'));
const beacon = new BeaconLink();
const serialWrite = beacon.writeLine;
beacon.writeLine = async line => { virtual.feed(line); await serialWrite(line); };
let lastBeaconEv = null;
setInterval(() => { if (lastBeaconEv && Date.now() - lastBeaconEv.receivedAt > 10000) beacon.push({ level: 'G', kind: 'N', count: 0, eta: -1, servo: -1, flap: -1 }); else beacon.tick(); }, 500);
virtual.feed(encodeBeacon(0, { level: 'G', kind: 'N', count: 0, eta: -1, servo: -1, flap: -1 }));
$('beaconBtn').addEventListener('click', async () => {
  if (beacon.stats.connected) { await beacon.disconnect(); $('beaconBtn').textContent = 'Connect Arduino beacon'; $('beaconStatus').textContent = 'Disconnected. On-screen beacon still running.'; return; }
  if (!BeaconLink.supported()) { $('beaconStatus').textContent = 'The Arduino link needs desktop Chrome or Edge.'; return; }
  try {
    await beacon.connect();
    $('beaconBtn').textContent = 'Disconnect beacon';
    $('beaconStatus').textContent = beacon.stats.ready ? `Connected: ${beacon.stats.device}` : 'Connected, but the beacon did not say READY. Check the sketch is uploaded.';
  } catch (err) { $('beaconStatus').textContent = `Could not connect: ${err.message}`; }
});

/* ---------- incidents ---------- */
const incidentEls = new Map();
function incidentItem(inc) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.innerHTML = '<b></b><span></span>';
  const n = inc.object_count;
  b.firstChild.textContent = `${inc.risk === 'red' ? 'Red' : 'Yellow'} · ${inc.type === 'drone' ? 'Drone' : n > 1 ? `${n} ${inc.type}s` : inc.type} · ${inc.camera_id}`;
  b.lastChild.textContent = `${new Date(inc.time).toLocaleString()}${inc.report ? ' · report ready' : ''}${inc.solana_tx ? ' · stamped on Solana' : ''}`;
  b.addEventListener('click', () => showIncident(inc));
  li.appendChild(b); return li;
}
function upsertIncident(inc) {
  const li = incidentItem(inc), old = incidentEls.get(inc._id);
  if (old) old.replaceWith(li); else $('incidents').prepend(li);
  incidentEls.set(inc._id, li);
  while ($('incidents').children.length > 40) $('incidents').lastChild.remove();
}
function showIncident(d) {
  const box = $('detail'); box.hidden = false; box.replaceChildren();
  const img = document.createElement('img'); img.alt = 'Snapshot from the camera';
  if (d.snapshot) img.src = `data:image/jpeg;base64,${d.snapshot}`;
  const text = document.createElement('div'); text.style.cssText = 'display:grid;gap:6px;align-content:start';
  const label = document.createElement('p'); label.innerHTML = '<b>Gemini sees:</b> '; label.append(d.gemini_label ?? 'waiting for the report…');
  const report = document.createElement('p'); report.textContent = d.report ?? '';
  text.append(label, report);
  if (d.solana_tx) { const a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View the Solana stamp'; text.append(a); }
  box.append(img, text);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(await auth.headers()), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function loadIncidents() {
  try { const list = await api('/api/incidents'); $('incidents').replaceChildren(); incidentEls.clear(); list.reverse().forEach(upsertIncident); $('incNote').textContent = ''; }
  catch (err) { $('incNote').textContent = err.message === 'incident store not configured' ? 'MongoDB is not connected yet, so reports appear here live only.' : `Could not load reports: ${err.message}`; }
}

/* ---------- hourly chart ---------- */
const chart = new Chart($('chart'), {
  type: 'bar',
  data: { labels: [], datasets: [{ label: 'Birds', data: [], backgroundColor: '#c2643f' }, { label: 'Drones', data: [], backgroundColor: '#1f1b16' }] },
  options: { animation: false, responsive: true, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } }
});
async function loadHourly() {
  try {
    const rows = await api('/api/hourly');
    const hours = [...new Set(rows.map(r => new Date(r.hour).toISOString()))].sort();
    const val = (h, type, field) => Number(rows.find(r => new Date(r.hour).toISOString() === h && r.type === type)?.[field] ?? 0);
    chart.data.labels = hours.map(h => new Date(h).toLocaleTimeString('en-US', { hour: 'numeric' }));
    chart.data.datasets[0].data = hours.map(h => val(h, 'bird', 'total_objects'));
    chart.data.datasets[1].data = hours.map(h => val(h, 'drone', 'events'));
    chart.update(); $('chartNote').textContent = rows.length ? '' : 'No detections in the last 24 hours yet.';
  } catch (err) { $('chartNote').textContent = err.message === 'database not configured' ? 'Tiger Data is not connected yet, so the chart is empty.' : `Could not load the chart: ${err.message}`; }
}

/* ---------- Ask SkySentry ---------- */
$('ask').addEventListener('submit', async e => {
  e.preventDefault();
  const question = $('q').value.trim(); if (!question) { $('answer').textContent = 'Type a question first.'; return; }
  $('answer').textContent = 'Thinking…';
  try { $('answer').textContent = (await api('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) })).answer; }
  catch (err) { $('answer').textContent = `The assistant could not answer: ${err.message}`; }
});

/* ---------- socket ---------- */
async function connect() {
  auth = await signIn({ role: 'dashboard', mount: $('auth') });
  $('who').textContent = auth.label;
  socket = io('/tower', { auth: cb => auth.socketAuth().then(cb) });
  socket.on('connect', () => { $('conn').textContent = 'Live'; $('conn').dataset.ok = '1'; loadIncidents(); loadHourly(); });
  socket.on('disconnect', () => { $('conn').textContent = 'Reconnecting…'; $('conn').dataset.ok = '0'; });
  socket.on('connect_error', err => { $('conn').textContent = err.message === 'unauthorized' ? 'Not allowed' : 'Offline'; $('conn').dataset.ok = '0'; });
  const online = new Set();
  const showCams = () => { $('cams').textContent = online.size ? `${online.size} camera${online.size > 1 ? 's' : ''}: ${[...online].join(', ')}` : 'No cameras'; };
  socket.on('camera:status', ({ cameraId, online: on }) => { on ? online.add(cameraId) : online.delete(cameraId); showCams(); });
  socket.on('camera:event', ev => {
    online.add(ev.cameraId); showCams();
    const prev = latest.get(ev.cameraId);
    latest.set(ev.cameraId, ev); refreshRisk(); feed(ev); placeCamera(ev); pin(ev);
    lastBeaconEv = ev; beacon.pushEvent(ev);
    // Without the AI step's voice, still sound the alarm when a camera turns red.
    if (ev.risk === 'red' && prev?.risk !== 'red') alarm();
  });
  socket.on('incident', upsertIncident);
  socket.on('alert', announce);
}
setInterval(loadHourly, 30000);
connect().catch(err => { if (err.message !== 'wrong role') $('conn').textContent = `Sign-in failed: ${err.message}`; });
