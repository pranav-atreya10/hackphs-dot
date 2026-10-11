// Tower dashboard: listens on this server's /tower namespace (Pranav's relay) for Vivan's contract events,
// shows risk, map pins from each camera's bearing, the hourly chart and incident reports, plays alerts,
// and drives the software beacon (Vivan's VirtualBeacon protocol, rendered on screen; no hardware needed).
import { signIn } from '/js/auth.js';
import { BeaconLink, VirtualBeacon, encodeBeacon } from '/detection/adapters/beacon.js';
import { startFeeds } from '/js/feeds.js';
import { VisualBirdVerifier } from '/js/visual-ai.js';
import { createAlertPlayer } from '/js/alert-player.mjs';

const $ = id => document.getElementById(id);
const RANK = { green: 0, yellow: 1, red: 2 };
const time = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
let auth = null, socket = null, soundOn = false, audioCtx = null;
// Airport picker: all-access towers (admins, tower key) can narrow everything to one airport. Kept in the URL
// (?airport=KTTN, shareable) and remembered in this browser; the server does the filtering.
const savedView = () => { try { return localStorage.getItem('skysentry.towerAirport') || ''; } catch { return ''; } };
let view = new URLSearchParams(location.search).get('airport') ?? savedView();

/* ---------- phone camera QR ---------- */
const camUrl = `${location.origin}/camera.html`;
$('camUrl').textContent = camUrl;
try { const qr = qrcode(0, 'M'); qr.addData(camUrl); qr.make(); $('qr').innerHTML = qr.createImgTag(4, 0, 'QR code that opens the SkySentry camera page on a phone'); } catch { $('qr').hidden = true; }
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
const announcements = createAlertPlayer({
  enabled: () => soundOn, alarm,
  showText: text => { $('alertText').textContent = text; },
  playAudio: audio => new Audio(`data:audio/mpeg;base64,${audio}`).play(),
  speakText: text => {
    if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.rate = .95; speechSynthesis.speak(u); }
  },
});

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
  // the same status, always visible in the sidebar
  const side = $('sideRisk'), what = describe(top);
  if (side.dataset.risk !== lvl || side.dataset.what !== what) {
    side.dataset.risk = lvl; side.dataset.what = what;
    const line = document.createElement('span');
    line.append(Object.assign(document.createElement('b'), { textContent: lvl.toUpperCase() }), ` · ${what}`);
    side.replaceChildren(line);
  }
  $('riskWhy').textContent = top ? `${top.cameraId} · ${time(top.receivedAt)}${top.eta_seconds != null ? ` · ${Math.round(top.eta_seconds)} s to corridor` : ''}${top.reasons?.length ? ' · ' + top.reasons.join(', ') : ''}` : 'No recent camera events';
}
setInterval(refreshRisk, 1000);

/* ---------- map: camera markers + field-of-view cones, threat pins and paths ---------- */
const map = L.map('map', { scrollWheelZoom: false }).setView([40.3987, -74.6586], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const camLayers = new Map(), pins = L.layerGroup().addTo(map);
let centered = false;
const dest = (lat, lon, brg, m) => { const b = brg * Math.PI / 180; return [lat + m * Math.cos(b) / 111320, lon + m * Math.sin(b) / (111320 * Math.cos(lat * Math.PI / 180))]; };
const validGeo = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) < 90;
function placeCamera(ev) {
  const c = ev.camera;
  if (!c || !validGeo([c.lon, c.lat]) || !Number.isFinite(c.heading_deg) || !Number.isFinite(c.hfov_deg) || c.hfov_deg <= 0 || c.hfov_deg > 180) return;
  const key = ev.cameraId, cone = [[c.lat, c.lon]];
  for (let i = 0; i <= 10; i++) cone.push(dest(c.lat, c.lon, c.heading_deg - c.hfov_deg / 2 + i * c.hfov_deg / 10, 400));
  camLayers.get(key)?.remove();
  const tooltip = document.createElement('span'); tooltip.textContent = `Camera ${key}`;
  camLayers.set(key, L.layerGroup([
    L.polygon(cone, { color: '#1f6fd1', weight: 1, fillOpacity: .08 }),
    L.circleMarker([c.lat, c.lon], { radius: 7, color: '#1f6fd1', fillOpacity: 1 }).bindTooltip(tooltip)
  ]).addTo(map));
  if (!centered) { map.setView([c.lat, c.lon], 16); centered = true; }
}
function pin(ev) {
  if (!validGeo(ev.target_geo?.coordinates) || ev.risk === 'green') return;
  const [lon, lat] = ev.target_geo.coordinates, color = ev.risk === 'red' ? '#c0392b' : '#d99a00';
  const popup = document.createElement('div'), description = document.createElement('b');
  description.textContent = describe(ev);
  popup.append(description, document.createElement('br'), document.createTextNode(`${time(ev.receivedAt)} · ${ev.cameraId}`));
  L.circleMarker([lat, lon], { radius: 8, color, fillOpacity: .85 }).bindPopup(popup).addTo(pins);
  const path = Array.isArray(ev.path_geo?.coordinates) ? ev.path_geo.coordinates.filter(validGeo) : [];
  if (path.length > 1) L.polyline(path.map(([x, y]) => [y, x]), { color, weight: 2, opacity: .6, dashArray: '4 4' }).addTo(pins);
  while (pins.getLayers().length > 60) pins.removeLayer(pins.getLayers()[0]);
}

/* ---------- live feed ---------- */
function feed(ev) {
  const li = document.createElement('li');
  const at = document.createElement('span'), level = document.createElement('span'), description = document.createElement('span');
  at.textContent = time(ev.receivedAt);
  level.className = `lv ${Object.hasOwn(RANK, ev.risk) ? ev.risk : 'unknown'}`;
  level.textContent = String(ev.risk ?? 'unknown');
  description.textContent = `${ev.cameraId} · ${describe(ev)}`;
  li.append(at, level, description);
  $('feed').prepend(li); while ($('feed').children.length > 80) $('feed').lastChild.remove();
}

/* ---------- beacon: Vivan's protocol, rendered in software (no Arduino) ---------- */
const virtual = new VirtualBeacon($('beaconView'));
const beacon = new BeaconLink();   // never connected to serial; it only encodes and paces the protocol lines
beacon.writeLine = async line => { virtual.feed(line); };
let lastBeaconEv = null;
setInterval(() => { if (lastBeaconEv && Date.now() - lastBeaconEv.receivedAt > 10000) beacon.push({ level: 'G', kind: 'N', count: 0, eta: -1, servo: -1, flap: -1 }); else beacon.tick(); }, 500);
virtual.feed(encodeBeacon(0, { level: 'G', kind: 'N', count: 0, eta: -1, servo: -1, flap: -1 }));
// Software-only beacon: the same G/Y/R protocol the old Arduino used, drawn on screen. The button puts it
// full screen so a spare monitor in the tower works as the warning light.
$('beaconBtn').addEventListener('click', async () => {
  const view = $('beaconView');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (view.requestFullscreen) await view.requestFullscreen();
    else $('beaconStatus').textContent = 'Full screen is not available in this browser; the beacon keeps running here.';
  } catch (err) { $('beaconStatus').textContent = `Full screen was blocked (${err.message}); the beacon keeps running here.`; }
});
document.addEventListener('fullscreenchange', () => {
  $('beaconBtn').textContent = document.fullscreenElement === $('beaconView') ? 'Exit full screen' : 'Full-screen beacon';
});

/* ---------- incidents ---------- */
const incidentEls = new Map(), incidentData = new Map();
let selectedIncident = null;
function incidentItem(inc) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.innerHTML = '<b></b><span></span>';
  const n = inc.object_count;
  b.firstChild.textContent = `${inc.risk === 'red' ? 'Red' : 'Yellow'} · ${inc.type === 'drone' ? 'Drone' : n > 1 ? `${n} ${inc.type}s` : inc.type} · ${inc.camera_id}`;
  b.lastChild.textContent = `${new Date(inc.time).toLocaleString()}${inc.report ? ' · report ready' : ''}${inc.solana_status === 'confirmed' || (inc.solana_tx && !inc.solana_status) ? ' · stamped on Solana' : inc.solana_status === 'pending' ? ' · stamp pending' : inc.solana_error ? ' · stamp needs attention' : ''}`;
  b.addEventListener('click', () => showIncident(inc));
  li.appendChild(b); return li;
}
function upsertIncident(inc) {
  inc = { ...(incidentData.get(inc._id) || {}), ...inc };
  incidentData.set(inc._id, inc);
  const li = incidentItem(inc), old = incidentEls.get(inc._id);
  if (old) old.replaceWith(li); else $('incidents').prepend(li);
  incidentEls.set(inc._id, li);
  while ($('incidents').children.length > 40) {
    const removed = $('incidents').lastChild;
    for (const [id, row] of incidentEls) if (row === removed) { incidentEls.delete(id); incidentData.delete(id); }
    removed.remove();
  }
  if (selectedIncident === inc._id) showIncident(inc);
}
function showIncident(d) {
  selectedIncident = d._id;
  const box = $('detail'); box.hidden = false; box.replaceChildren();
  const img = document.createElement('img'); img.alt = 'Snapshot from the camera';
  if (d.snapshot) img.src = d.snapshot.startsWith('data:image/') ? d.snapshot : `data:image/jpeg;base64,${d.snapshot}`;
  else img.hidden = true;
  const text = document.createElement('div'); text.style.cssText = 'display:grid;gap:6px;align-content:start';
  const label = document.createElement('p'); label.innerHTML = '<b>Image review:</b> '; label.append(d.gemini_label ?? 'waiting for the report…');
  const report = document.createElement('p'); report.textContent = d.report ?? '';
  text.append(label, report);
  if (d.report_hash) { const p = document.createElement('p'); p.textContent = `Report fingerprint: ${d.report_hash.slice(0, 16)}…`; text.append(p); }
  if (d.solana_error) { const p = document.createElement('p'); p.textContent = `Solana: ${d.solana_error}`; text.append(p); }
  else if (d.type === 'drone' && d.solana_status === 'hash only') { const p = document.createElement('p'); p.textContent = 'Report hashed locally. Connect a funded devnet wallet to stamp it on Solana.'; text.append(p); }
  if (d.solana_tx) { const a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = d.solana_status === 'pending' ? 'Check pending Solana stamp' : 'View the Solana stamp'; text.append(a); }
  box.append(img, text);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(await auth.headers()), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function loadIncidents() {
  try { const list = await api(`/api/incidents${view ? `?airport=${encodeURIComponent(view)}` : ''}`); $('incidents').replaceChildren(); incidentEls.clear(); incidentData.clear(); list.reverse().forEach(upsertIncident); $('incNote').textContent = ''; }
  catch (err) { $('incNote').textContent = err.message === 'incident store not configured' ? 'MongoDB is not connected yet, so reports appear here live only.' : `Could not load reports: ${err.message}`; }
}

/* ---------- hourly chart ---------- */
// Monochrome bars from the page's theme tokens; recoloured when the theme switches (js/theme.js).
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
Chart.defaults.font.family = token('--sans');
const chart = new Chart($('chart'), {
  type: 'bar',
  data: { labels: [], datasets: [{ label: 'Birds', data: [], borderRadius: 3 }, { label: 'Drones', data: [], borderRadius: 3 }] },
  options: { animation: false, responsive: true, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } }
});
function themeChart() {
  const ink = token('--ink'), mute = token('--mute'), line = token('--line');
  chart.data.datasets[0].backgroundColor = mute; chart.data.datasets[1].backgroundColor = ink;
  for (const axis of [chart.options.scales.x, chart.options.scales.y]) { axis.ticks.color = mute; axis.border = { color: line }; }
  chart.options.scales.y.grid = { color: line };
  chart.options.plugins.legend.labels.color = mute;
  chart.update();
}
themeChart();
document.documentElement.addEventListener('themechange', themeChart);
async function loadHourly() {
  try {
    const rows = await api('/api/hourly');
    const hours = [...new Set(rows.map(r => new Date(r.hour).toISOString()))].sort();
    const val = (h, type, field) => Number(rows.find(r => new Date(r.hour).toISOString() === h && r.type === type)?.[field] ?? 0);
    chart.data.labels = hours.map(h => new Date(h).toLocaleTimeString('en-US', { hour: 'numeric' }));
    chart.data.datasets[0].data = hours.map(h => val(h, 'bird', 'total_objects'));
    chart.data.datasets[1].data = hours.map(h => val(h, 'drone', 'events'));
    chart.update(); $('chartNote').textContent = rows.length ? (view ? 'Hourly totals cover every airport.' : '') : 'No detections in the last 24 hours yet.';
  } catch (err) { $('chartNote').textContent = err.message === 'database not configured' ? 'Tiger Data is not connected yet, so the chart is empty.' : `Could not load the chart: ${err.message}`; }
}

/* ---------- Ask SkySentry (copilot chat: OpenAI with tools, Gemini fallback) ---------- */
let chatHistory = [];
function chatBubble(role, text) {
  const li = document.createElement('li'); li.className = role === 'user' ? 'user' : 'bot';
  li.textContent = text; $('chat').append(li); $('chat').scrollTop = $('chat').scrollHeight;
  return li;
}
$('ask').addEventListener('submit', async e => {
  e.preventDefault();
  const question = $('q').value.trim(); if (!question) { $('q').focus(); return; }
  $('q').value = ''; $('askClear').hidden = false;
  chatHistory.push({ role: 'user', content: question }); chatBubble('user', question);
  const reply = chatBubble('bot', 'Thinking…'); reply.setAttribute('aria-busy', 'true');
  const button = $('ask').querySelector('button'); button.disabled = true;
  try {
    const r = await api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: chatHistory, airport: view || undefined }) });
    reply.textContent = r.answer; chatHistory.push({ role: 'assistant', content: r.answer });
    const meta = document.createElement('div'); meta.className = 'meta';
    for (const label of r.tools || []) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = label; meta.append(s); }
    for (const id of r.incident_ids || []) {
      const inc = incidentData.get(id); if (!inc) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
      b.textContent = `${inc.type} · ${new Date(inc.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      b.addEventListener('click', () => { showIncident(inc); incidentEls.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
      meta.append(b);
    }
    if (r.source === 'fallback') { const s = document.createElement('span'); s.className = 'chip'; s.textContent = 'basic mode'; meta.append(s); }
    if (meta.childElementCount) reply.append(meta);
  } catch (err) {
    reply.textContent = `The assistant could not answer: ${err.message}`;
    chatHistory.pop();   // let the question be asked again
  } finally { reply.removeAttribute('aria-busy'); button.disabled = false; chatHistory = chatHistory.slice(-12); }
});
$('askClear').addEventListener('click', () => { chatHistory = []; $('chat').replaceChildren(); $('askClear').hidden = true; $('q').focus(); });

/* ---------- airport picker ---------- */
async function setupAirports() {
  const { airports = [], scoped = false } = await api('/api/airports').catch(() => ({}));
  const label = a => (a.name && a.name !== a.code ? `${a.code} · ${a.name}` : a.code);
  const input = $('airportSearch');
  if (scoped || !airports.some(a => a.code === view)) view = '';
  $('airportBox').hidden = !airports.length;
  if (scoped) { input.value = airports[0] ? label(airports[0]) : ''; input.disabled = true; $('airportHint').textContent = 'Your account’s airport.'; return; }
  $('airportList').replaceChildren(...['All airports', ...airports.map(label)].map(v => Object.assign(document.createElement('option'), { value: v })));
  input.value = view ? label(airports.find(a => a.code === view)) : '';
  $('airportHint').textContent = `${airports.length} airport${airports.length === 1 ? '' : 's'} · type a code or name`;
  if (view) document.querySelector('.page-head h1').textContent = `Tower · ${view}`;
  const choose = () => {
    const q = input.value.trim().toLowerCase();
    const next = !q || q === 'all airports' ? ''
      : (airports.find(a => label(a).toLowerCase() === q || a.code.toLowerCase() === q) || airports.find(a => label(a).toLowerCase().includes(q)))?.code;
    if (next === undefined) { $('airportHint').textContent = 'No airport matches that.'; return; }
    if (next === view) { input.value = next ? label(airports.find(a => a.code === next)) : ''; return; }
    try { localStorage.setItem('skysentry.towerAirport', next); } catch {}
    const url = new URL(location.href);
    next ? url.searchParams.set('airport', next) : url.searchParams.delete('airport');
    location.assign(url);   // reconnect cleanly so feeds, map and alerts only carry this airport
  };
  input.addEventListener('change', choose);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') choose(); if (e.key === 'Escape') { input.value = view ? label(airports.find(a => a.code === view)) : ''; input.blur(); } });
}

/* ---------- socket ---------- */
async function connect() {
  auth = await signIn({ role: 'dashboard', mount: $('auth') });
  $('addCamera').hidden = auth.role === 'dashboard';   // tower accounts don't set up cameras; admins and keys still can
  await setupAirports();
  socket = io('/tower', { auth: cb => auth.socketAuth(view ? { airport: view } : undefined).then(cb) });
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
    // The server emits the immediate red alert separately; announce it once by incident ID.
  });
  socket.on('incident', upsertIncident);
  const visualBirds = new VisualBirdVerifier({ socket, button: $('birdCheck'), status: $('birdCheckStatus'),
    judge: (image, context) => api('/api/verify-bird', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, context }) }) });
  // Warm the browser cache with the bird model while the tower is idle, so "Enable" is near-instant later.
  const warm = () => ['/ai-models/tf.min.js', '/ai-models/coco-ssd.min.js', '/ai-models/coco/model.json'].forEach(href => { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = href; document.head.append(l); });
  ('requestIdleCallback' in window) ? requestIdleCallback(warm, { timeout: 4000 }) : setTimeout(warm, 3000);
  startFeeds(socket, { container: $('feeds'), hint: $('feedsHint'), onFeed: t => visualBirds.onFeed(t) });
  socket.on('alert', announcements.receive);
  socket.on('alert_update', announcements.update);
}
setInterval(loadHourly, 30000);
connect().catch(err => { if (err.message !== 'wrong role') $('conn').textContent = `Sign-in failed: ${err.message}`; });
