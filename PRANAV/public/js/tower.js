// Tower dashboard: listens on this server's /tower namespace (Pranav's relay) for Vivan's contract events,
// shows risk, camera coverage on a map, the hourly chart and incident reports, plays alerts,
// and drives the software beacon (Vivan's VirtualBeacon protocol, rendered on screen; no hardware needed).
import { signIn, refreshSocketAuth } from '/js/auth.js';
import { VirtualBeacon, encodeBeacon, frameFromEvent } from '/detection/adapters/beacon.js';
import { createTowerMonitoring, imageEta, operational, RISK_RANK } from '/js/tower-monitoring.mjs';
import { createTowerLayers } from '/js/tower-layers.mjs';
import { startFeeds } from '/js/feeds.js';
import { VisualBirdVerifier } from '/js/visual-ai.js';
import { createAlertPlayer } from '/js/alert-player.mjs';

const $ = id => document.getElementById(id);
const time = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
let auth = null, socket = null, soundOn = false, audioCtx = null;
// Airport picker: administrators select one airport. Kept in the URL
// (?airport=KTTN, shareable) and remembered in this browser; the server does the filtering.
const savedView = () => { try { return localStorage.getItem('skysentry.towerAirport') || ''; } catch { return ''; } };
let view = new URLSearchParams(location.search).get('airport') ?? savedView();

/* ---------- phone camera QR ---------- */
const camUrl = `${location.origin}/camera.html`;
$('camUrl').textContent = camUrl;
try { const qr = qrcode(0, 'M'); qr.addData(camUrl); qr.make(); $('qr').innerHTML = qr.createImgTag(4, 0, 'QR code that opens the SkySentry camera page on a phone'); } catch { $('qr').hidden = true; }
if (location.protocol !== 'https:' && !/^(localhost|127\.)/.test(location.hostname)) $('camUrl').textContent += ' (phones need https for the camera; use the deployed site)';

/* ---------- sound: alarm, then the browser's voice reads the alert ---------- */
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

/* ---------- operational risk and coverage ---------- */
const monitoring = createTowerMonitoring();
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
function describe(ev) {
  if (!ev || ev.risk === 'green') return 'No detections in monitored video';
  if (ev.direction === 'heard, not seen') return 'Drone heard, not seen';
  const n = ev.flock_size || ev.object_count;
  const type = ['bird', 'drone'].includes(ev.type) ? ev.type : 'object';
  const target = n > 1 ? `${n} ${type}s` : type === 'object' ? 'Unknown object' : `One ${type}`;
  return typeof ev.direction === 'string' && ev.direction ? `${target} · ${ev.direction}` : target;
}
function refreshRisk() {
  const snapshot = monitoring.snapshot();
  const { level, coverage, reason, top, online } = snapshot;
  const what = top ? describe(top) : level === 'green' ? 'No detections in monitored video'
    : coverage === 'degraded' ? 'Limited monitoring' : 'No usable monitoring';
  $('risk').dataset.risk = level;
  setText($('riskLvl'), level.toUpperCase());
  setText($('riskWhat'), what);
  const side = $('sideRisk');
  const sideText = coverage === 'degraded' && top ? `${what} · limited monitoring` : what;
  if (side.dataset.risk !== level || side.dataset.what !== sideText) {
    side.dataset.risk = level; side.dataset.what = sideText;
    const line = document.createElement('span');
    line.append(Object.assign(document.createElement('b'), { textContent: level.toUpperCase() }), ` · ${sideText}`);
    side.replaceChildren(line);
  }
  const eta = imageEta(top);
  const coverageLimit = ' · Video only; drone audio not monitored. Not a clearance.';
  const detail = (top ? ` · ${top.cameraLabel}${eta === null ? '' : ` · projected image-mask entry in ${Math.round(eta)} s`}` : '') + coverageLimit;
  setText($('riskWhy'), `${reason}${detail}`);
  setText($('cams'), online.length ? `${online.length} camera${online.length > 1 ? 's' : ''}: ${online.join(', ')}` : 'No live cameras');
  renderBeacon(snapshot, what, detail);
  const warningIds = new Set(snapshot.warnings.map(ev => ev.cameraId));
  layers?.prune(snapshot.cameraIds, warningIds);
  for (const ev of snapshot.warnings) layers?.pin(ev);
}

/* ---------- map: camera markers + field-of-view cones, threat pins and paths ---------- */
const map = L.map('map', { scrollWheelZoom: false }).setView([40.3987, -74.6586], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const layers = createTowerLayers(L, map, { describe });

/* ---------- live feed ---------- */
function feed(ev) {
  const li = document.createElement('li');
  const at = document.createElement('span'), level = document.createElement('span'), description = document.createElement('span');
  at.textContent = time(ev.receivedAt);
  level.className = `lv ${Object.hasOwn(RISK_RANK, ev.risk) ? ev.risk : 'unknown'}`;
  level.textContent = String(ev.risk ?? 'unknown');
  description.textContent = `${ev.cameraLabel || ev.cameraId} · ${describe(ev)}`;
  li.append(at, level, description);
  $('feed').prepend(li); while ($('feed').children.length > 80) $('feed').lastChild.remove();
}

/* ---------- beacon: Vivan's protocol, rendered in software ---------- */
const lamps = $('beaconLamps'), virtual = new VirtualBeacon(lamps);
let beaconSeq = 0;
function renderBeacon({ level, coverage, reason, top }, what, detail) {
  const hasRisk = Object.hasOwn(RISK_RANK, level);
  lamps.hidden = !hasRisk;
  setText($('beaconReading'), `${level.toUpperCase()} · ${what}`);
  setText($('beaconCoverage'), `${coverage === 'degraded' ? 'Limited coverage · ' : ''}${reason}${detail}`);
  if (!hasRisk) return;
  const frame = frameFromEvent({ ...top, risk: level, eta_seconds: null,
    bearing_deg: Number.isFinite(top?.camera?.heading_deg) && Number.isFinite(top?.bearing_deg) ? top.bearing_deg : null,
    classification: ['bird', 'drone'].includes(top?.classification ?? top?.type) ? top.classification ?? top.type : 'unknown',
  });
  lamps.querySelector('[data-arrow]').hidden = frame.servo < 0;
  virtual.feed(encodeBeacon(++beaconSeq % 100000, frame));
  virtual.render();
}
setInterval(refreshRisk, 500);
const preview = $('towerDemo');
preview.addEventListener('toggle', () => {
  const video = preview.querySelector('video');
  if (preview.open) video.src = video.dataset.src;
  else { video.pause(); video.removeAttribute('src'); video.load(); }
});
// Software-only beacon: Vivan's G/Y/R protocol drawn on screen. The button puts it
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
  if (d.bird_verdict?.status === 'verified') {
    const p = document.createElement('p');
    const { verdict, confidence, evidence } = d.bird_verdict;
    p.textContent = `Gemini bird check: ${verdict.replace('_', ' ')} (${Math.round(confidence * 100)}%). ${evidence}`;
    text.append(p);
  } else if (d.bird_verdict?.status === 'unavailable') {
    const p = document.createElement('p');
    p.textContent = `Gemini bird check unavailable. ${d.bird_verdict.evidence}`;
    text.append(p);
  }
  if (d.report_hash) { const p = document.createElement('p'); p.textContent = `Report fingerprint: ${d.report_hash.slice(0, 16)}…`; text.append(p); }
  if (d.solana_error) { const p = document.createElement('p'); p.textContent = `Solana: ${d.solana_error}`; text.append(p); }
  else if (d.type === 'drone' && d.solana_status === 'hash only') { const p = document.createElement('p'); p.textContent = 'Report hashed locally. Connect a funded devnet wallet to stamp it on Solana.'; text.append(p); }
  if (d.solana_tx) { const a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = d.solana_status === 'pending' ? 'Check pending Solana stamp' : 'View the Solana stamp'; text.append(a); }
  box.append(img, text);
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(await auth.headers()), ...(view ? { 'x-airport': view } : {}), ...(opts.headers || {}) } });
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
    chart.update(); $('chartNote').textContent = rows.length ? '' : 'No detections in the last 24 hours yet.';
  } catch (err) { $('chartNote').textContent = `Could not load the chart: ${err.message}`; }
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
  const { airports = [], scoped = false } = await api('/api/airports');
  const label = a => (a.name && a.name !== a.code ? `${a.code} · ${a.name}` : a.code);
  const input = $('airportSearch');
  if (scoped || !airports.some(a => a.code === view)) view = airports[0]?.code || '';
  $('airportBox').hidden = !airports.length;
  if (scoped) { input.value = airports[0] ? label(airports[0]) : ''; input.disabled = true; $('airportHint').textContent = 'Your account’s airport.'; return; }
  $('airportList').replaceChildren(...airports.map(label).map(v => Object.assign(document.createElement('option'), { value: v })));
  input.value = view ? label(airports.find(a => a.code === view)) : '';
  $('airportHint').textContent = `${airports.length} airport${airports.length === 1 ? '' : 's'} · type a code or name`;
  if (view) document.querySelector('.page-head h1').textContent = `Tower · ${view}`;
  const choose = () => {
    const q = input.value.trim().toLowerCase();
    const next = !q ? undefined
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
  if (!view) throw new Error('No authorized airport is configured');
  socket = io('/tower', { auth: cb => auth.socketAuth(view ? { airport: view } : undefined).then(cb) });
  refreshSocketAuth(socket, auth);
  socket.on('connect', () => {
    $('conn').textContent = 'Connected'; $('conn').dataset.ok = '1';
    monitoring.setConnected(true); refreshRisk(); loadIncidents(); loadHourly();
  });
  const disconnected = label => {
    $('conn').textContent = label; $('conn').dataset.ok = '0';
    monitoring.setConnected(false); refreshRisk();
  };
  socket.on('disconnect', reason => disconnected(reason === 'io server disconnect' ? 'Access ended; reload to reconnect' : 'Reconnecting…'));
  socket.on('connect_error', err => disconnected(err.message === 'unauthorized' ? 'Not allowed' : 'Offline'));
  socket.on('camera:status', packet => { if (monitoring.status(packet)) refreshRisk(); });
  socket.on('camera:heartbeat', packet => monitoring.heartbeat(packet));
  socket.on('camera:frame', packet => monitoring.heartbeat(packet));
  socket.on('bot:status', packet => { if (monitoring.mode(packet)) refreshRisk(); });
  socket.on('bot:state', packet => monitoring.detector(packet));
  socket.on('camera:event', packet => {
    const ev = monitoring.event(packet);
    if (!ev) return;
    layers?.placeCamera(ev);
    feed(ev);
    refreshRisk();
  });
  socket.on('incident', packet => { if (operational(packet)) upsertIncident(packet); });
  const visualBirds = new VisualBirdVerifier({ button: $('birdCheck'), status: $('birdCheckStatus'), reviewStatus: $('birdReviewStatus') });
  api('/api/cloud-evidence-policy').then(({ cloudEvidenceEnabled }) => {
    if (cloudEvidenceEnabled === true) {
      visualBirds.judge = ref => api('/api/verify-bird', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(ref) });
    }
  }).catch(() => { /* An unknown policy means local-only. */ });
  startFeeds(socket, { container: $('feeds'), hint: $('feedsHint'), demo: false,
    onFeed: t => { if (!t.demo) visualBirds.onFeed(t); },
    onRemove: cameraId => visualBirds.feeds.delete(cameraId) });
  socket.on('alert', packet => { if (operational(packet)) announcements.receive(packet); });
  socket.on('alert_update', packet => { if (operational(packet)) announcements.update(packet); });
}
setInterval(loadHourly, 30000);
connect().catch(err => { if (err.message !== 'wrong role') $('conn').textContent = `Sign-in failed: ${err.message}`; });
