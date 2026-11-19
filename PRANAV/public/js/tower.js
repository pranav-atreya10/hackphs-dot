// Tower dashboard: listens on this server's /tower namespace (Pranav's relay) for Vivan's contract events,
// shows risk, camera coverage on a map, the hourly chart and incident reports, plays alerts,
// and drives the software beacon (Vivan's VirtualBeacon protocol, rendered on screen; no hardware needed).
import { signIn, refreshSocketAuth, panel } from '/js/auth.js';
import { VirtualBeacon, encodeBeacon, frameFromEvent } from '/detection/adapters/beacon.js';
import { createTowerMonitoring, imageEta, operational, RISK_RANK } from '/js/tower-monitoring.mjs';
import { createTowerLayers } from '/js/tower-layers.mjs';
import { createAlertPlayer } from '/js/alert-player.mjs';
import { reconcileIncidents } from '/js/incident-history.mjs';

const $ = id => document.getElementById(id);
const time = ms => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
let auth = null, socket = null, soundOn = false, audioCtx = null;
// Airport picker: administrators select one airport. Kept in the URL
// (?airport=KTTN, shareable) and remembered in this browser; the server does the filtering.
const savedView = () => { try { return localStorage.getItem('skysentry.towerAirport') || ''; } catch { return ''; } };
let view = new URLSearchParams(location.search).get('airport') ?? savedView();

function loadAsset(tag, url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    const failed = () => { clearTimeout(timer); el.remove(); reject(new Error('Asset could not be loaded')); };
    const timer = setTimeout(failed, 10000);
    el.onload = () => { clearTimeout(timer); resolve(el); };
    el.onerror = failed;
    if (tag === 'link') { el.href = url; el.rel = 'stylesheet'; }
    else { el.src = url; el.async = true; }
    document.head.append(el);
  });
}
function feature(label, statusId, init) {
  let loading = null;
  const start = () => {
    if (!loading) {
      $(statusId).textContent = `Loading ${label}…`;
      loading = Promise.resolve().then(init).then(() => {
        $(statusId).textContent = '';
        return true;
      }).catch(err => {
        console.warn(`${label} unavailable:`, err);
        loading = null;
        const retry = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Retry' });
        retry.onclick = start;
        $(statusId).replaceChildren(`${label} unavailable. `, retry);
        return false;
      });
    }
    return loading;
  };
  return start;
}

/* ---------- phone camera QR ---------- */
const camUrl = `${location.origin}/camera.html`;
$('camUrl').textContent = camUrl;
const initQR = feature('QR code', 'qrNote', async () => {
  if (!window.qrcode) await loadAsset('script', '/vendor/qrcode.min.js');
  const qr = window.qrcode(0, 'M');
  qr.addData(camUrl); qr.make();
  $('qr').innerHTML = qr.createImgTag(4, 0, 'QR code that opens the SkySentry camera page on a phone');
});
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

const alerts = new Map(), acknowledgedAlerts = new Set();
let alertSyncGeneration = 0;
const scopedAlert = row => operational(row) && row.airport === view && typeof row.id === 'string';
function removeAlert(id) {
  alerts.get(id)?.row.remove();
  alerts.delete(id);
}
function acknowledgeAlert(id) {
  if (acknowledgedAlerts.size >= 1000) acknowledgedAlerts.delete(acknowledgedAlerts.values().next().value);
  acknowledgedAlerts.add(id);
  removeAlert(id);
}
function showAlert(data, { replay = false, provisional = false } = {}) {
  if (!scopedAlert(data) || acknowledgedAlerts.has(data.id)) return;
  const { id } = data;
  let entry = alerts.get(id);
  if (!entry) {
    if (alerts.size >= 200) removeAlert(alerts.keys().next().value);
    const row = document.createElement('li'), label = document.createElement('span'), status = document.createElement('span');
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Acknowledge', className: 'ghost' });
    label.textContent = data.text;
    button.addEventListener('click', () => {
      button.disabled = true;
      socket.timeout(5000).emit('alert:acknowledge', id, (err, receipt) => {
        if (!err && receipt?.ok) acknowledgeAlert(id);
        else { status.textContent = ' Acknowledgment not confirmed. Try again. '; button.disabled = false; }
      });
    });
    row.append(label, status, button);
    $('unacknowledgedAlerts').append(row);
    entry = { row, status, button, committed: false };
    alerts.set(id, entry);
  }
  if (provisional && !entry.committed) {
    entry.status.textContent = data.storage_failed ? ' Not confirmed by storage. ' : ' Waiting for durable storage. ';
    entry.button.hidden = true;
  } else if (!provisional) {
    entry.committed = true;
    entry.status.textContent = replay ? ' Recovered from alert history. ' : ' ';
    entry.button.hidden = false;
  }
  announcements.receive(data, { replay });
}
function replayAlerts() {
  if (!socket?.connected || typeof socket.timeout !== 'function') return;
  const generation = ++alertSyncGeneration;
  const unseen = new Map([...alerts].filter(([, entry]) => entry.committed));
  const page = (cursor, count) => {
    socket.timeout(5000).emit('alert:replay', cursor, (err, result) => {
      if (generation !== alertSyncGeneration || !socket.connected) return;
      if (err || !result?.ok || !Array.isArray(result.alerts)) {
        $('alertSync').textContent = 'Alert history unavailable; retrying.';
        return;
      }
      for (const data of result.alerts) {
        if (!scopedAlert(data)) continue;
        unseen.delete(data.id);
        showAlert(data, { replay: true });
      }
      if (result.next && result.next !== cursor && count < 10) return page(result.next, count + 1);
      if (result.next) { $('alertSync').textContent = 'Showing a partial alert history.'; return; }
      for (const [id, entry] of unseen) if (alerts.get(id) === entry) acknowledgeAlert(id);
      $('alertSync').textContent = '';
    });
  };
  page(null, 1);
}

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
let layers, leafletStyles;
const initMap = feature('Airport map', 'mapNote', async () => {
  await Promise.all([
    leafletStyles ||= loadAsset('link', '/vendor/leaflet/leaflet.css').catch(err => { leafletStyles = null; throw err; }),
    window.L || loadAsset('script', '/vendor/leaflet/leaflet.js'),
  ]);
  let map;
  try {
    map = L.map('map', { scrollWheelZoom: false });
    map.setView([40.3987, -74.6586], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    layers = createTowerLayers(L, map, { describe });
    for (const ev of cameraPositions.values()) layers.placeCamera(ev);
    refreshRisk();
  } catch (err) {
    map?.remove(); layers = null;
    throw err;
  }
});
const cameraPositions = new Map();

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
const lamps = $('beaconLamps');
let beaconSeq = 0, virtual;
function renderBeacon({ level, coverage, reason, top }, what, detail) {
  const hasRisk = Object.hasOwn(RISK_RANK, level);
  lamps.hidden = !hasRisk;
  setText($('beaconReading'), `${level.toUpperCase()} · ${what}`);
  setText($('beaconCoverage'), `${coverage === 'degraded' ? 'Limited coverage · ' : ''}${reason}${detail}`);
  if (!hasRisk) return;
  virtual ??= new VirtualBeacon(lamps);
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
const incidentEls = new Map();
let incidentData = new Map(), historyRequest;
let selectedIncident = null;
let evidenceRequest, evidenceUrl;
function incidentItem(inc) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.innerHTML = '<b></b><span></span>';
  const n = inc.object_count;
  b.firstChild.textContent = `${inc.risk === 'red' ? 'Red' : 'Yellow'} · ${inc.type === 'drone' ? 'Drone' : n > 1 ? `${n} ${inc.type}s` : inc.type} · ${inc.camera_id}`;
  b.lastChild.textContent = `${new Date(inc.time).toLocaleString()}${inc.report ? ' · report ready' : ''}${inc.solana_status === 'confirmed' || (inc.solana_tx && !inc.solana_status) ? ' · stamped on Solana' : inc.solana_status === 'pending' ? ' · stamp pending' : inc.solana_error ? ' · stamp needs attention' : ''}`;
  b.addEventListener('click', () => showIncident(inc));
  li.appendChild(b); return li;
}
function updateIncidents(rows, source) {
  const next = reconcileIncidents(incidentData, rows, source);
  for (const [id, el] of incidentEls) {
    if (!next.has(id)) { el.remove(); incidentEls.delete(id); }
  }
  let at = $('incidents').firstChild;
  for (const [id, entry] of next) {
    let el = incidentEls.get(id);
    if (incidentData.get(id) !== entry || !el) {
      const replacement = incidentItem(entry.row);
      if (el && el === at) at = replacement;
      el?.replaceWith(replacement);
      incidentEls.set(id, replacement); el = replacement;
    }
    if (el !== at || !el.parentNode) $('incidents').insertBefore(el, at);
    at = el.nextSibling;
  }
  const selected = next.get(selectedIncident), previous = incidentData.get(selectedIncident);
  if (selected && selected !== previous) {
    renderIncidentReport(selected.row, $('incidentReport'));
    if (selected.row.snapshot_state === 'stored' && previous?.row.snapshot_state !== 'stored') void loadEvidence(selected.row, $('incidentEvidence'));
  }
  if (!selected && selectedIncident) {
    evidenceRequest?.abort();
    if (evidenceUrl) URL.revokeObjectURL(evidenceUrl);
    selectedIncident = evidenceUrl = null;
    $('detail').replaceChildren(); $('detail').hidden = true;
  }
  incidentData = next;
}
function showIncident(d) {
  d = incidentData.get(d._id)?.row || d;
  if (selectedIncident === d._id) return;
  evidenceRequest?.abort();
  if (evidenceUrl) { URL.revokeObjectURL(evidenceUrl); evidenceUrl = null; }
  selectedIncident = d._id;
  const box = $('detail'); box.hidden = false; box.replaceChildren();
  const evidence = document.createElement('div');
  evidence.id = 'incidentEvidence';
  const text = document.createElement('div');
  text.id = 'incidentReport'; text.style.cssText = 'display:grid;gap:6px;align-content:start';
  box.append(evidence, text);
  renderIncidentReport(d, text);
  loadEvidence(d, evidence);
}
async function loadEvidence(d, container) {
  if (!d.airport) { container.textContent = 'No airport-scoped snapshot is available.'; return; }
  if (d.snapshot_state && d.snapshot_state !== 'stored') {
    container.textContent = d.snapshot_state === 'pending' ? 'Snapshot storage is pending.'
      : d.snapshot_state === 'invalid' ? 'The snapshot did not pass validation and was not retained.'
      : 'No snapshot retained for this incident.';
    return;
  }
  evidenceRequest?.abort();
  const request = new AbortController();
  evidenceRequest = request;
  container.textContent = 'Loading snapshot…';
  try {
    const r = await fetch(`/api/incidents/${encodeURIComponent(d._id)}/snapshot?airport=${encodeURIComponent(d.airport)}`, {
      headers: await auth.headers(), signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), cache: 'no-store',
    });
    if (!r.ok || r.headers.get('content-type') !== 'image/jpeg') throw new Error(`HTTP ${r.status}`);
    const image = await r.blob();
    if (request.signal.aborted) return;
    evidenceUrl = URL.createObjectURL(image);
    const img = document.createElement('img'); img.alt = 'Snapshot from the camera'; img.src = evidenceUrl;
    container.replaceChildren(img);
  } catch (err) {
    if (request.signal.aborted) return;
    const retry = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Retry snapshot' });
    retry.onclick = () => loadEvidence(d, container);
    container.replaceChildren(err.message === 'HTTP 404' ? 'No snapshot available yet. ' : 'Could not load snapshot. ', retry);
  }
}
function renderIncidentReport(d, text) {
  text.replaceChildren();
  const label = document.createElement('p'); label.innerHTML = '<b>Advisory report:</b> ';
  label.append(d.gemini_label ?? (['unavailable', 'incomplete'].includes(d.report_state) ? 'report unavailable' : 'waiting for the report…'));
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
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(await auth.headers()), ...(view ? { 'x-airport': view } : {}), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function loadIncidents() {
  historyRequest?.abort();
  const request = new AbortController();
  historyRequest = request;
  try {
    const list = await api(`/api/incidents${view ? `?airport=${encodeURIComponent(view)}` : ''}`, { signal: request.signal });
    if (request.signal.aborted) return;
    if (!Array.isArray(list)) throw new Error('Invalid report list');
    updateIncidents(list, 'history');
    $('incNote').textContent = '';
  } catch (err) {
    if (!request.signal.aborted) $('incNote').textContent = `Could not load reports: ${err.message}`;
  }
}

/* ---------- hourly chart ---------- */
// Monochrome bars from the page's theme tokens; recoloured when the theme switches (js/theme.js).
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let chart, loadingHourly = false;
const initChart = feature('Hourly chart', 'chartNote', async () => {
  if (!window.Chart) await loadAsset('script', '/vendor/chart.umd.min.js');
  Chart.defaults.font.family = token('--sans');
  chart = new Chart($('chart'), {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Birds', data: [], borderRadius: 3 }, { label: 'Drones', data: [], borderRadius: 3 }] },
    options: { animation: false, responsive: true, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } }
  });
  try { themeChart(); }
  catch (err) { chart.destroy(); chart = null; throw err; }
  document.documentElement.addEventListener('themechange', themeChart);
});
function themeChart() {
  const ink = token('--ink'), mute = token('--mute'), line = token('--line');
  chart.data.datasets[0].backgroundColor = mute; chart.data.datasets[1].backgroundColor = ink;
  for (const axis of [chart.options.scales.x, chart.options.scales.y]) { axis.ticks.color = mute; axis.border = { color: line }; }
  chart.options.scales.y.grid = { color: line };
  chart.options.plugins.legend.labels.color = mute;
  chart.update();
}
async function loadHourly() {
  if (!chart || !socket?.connected || !$('more').open || loadingHourly) return;
  loadingHourly = true;
  try {
    const rows = await api('/api/hourly', { signal: AbortSignal.timeout(10000) });
    const hours = [...new Set(rows.map(r => new Date(r.hour).toISOString()))].sort();
    const val = (h, type, field) => Number(rows.find(r => new Date(r.hour).toISOString() === h && r.type === type)?.[field] ?? 0);
    chart.data.labels = hours.map(h => new Date(h).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', timeZone: 'UTC' }));
    chart.data.datasets[0].data = hours.map(h => val(h, 'bird', 'total_objects'));
    chart.data.datasets[1].data = hours.map(h => val(h, 'drone', 'events'));
    chart.update(); $('chartNote').textContent = rows.length ? '' : 'No detections in the last 24 hours yet.';
  } catch (err) { $('chartNote').textContent = err.message === 'database not configured' ? 'The database is not connected yet, so the chart is empty.' : `Could not load the chart: ${err.message}`; }
  finally { loadingHourly = false; }
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
      const inc = incidentData.get(id)?.row; if (!inc) continue;
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
  const { airports = [], scoped = false } = await api('/api/airports', { signal: AbortSignal.timeout(10000) });
  const label = a => (a.name && a.name !== a.code ? `${a.code} · ${a.name}` : a.code);
  const input = $('airportSearch');
  if (view && !airports.some(a => a.code === view)) {
    throw new Error('The selected airport is not available. Select an authorized airport.');
  }
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
    if (next === undefined || (auth.airportRequired && !next)) { $('airportHint').textContent = 'Select an authorized airport.'; return; }
    if (next === view) { input.value = next ? label(airports.find(a => a.code === next)) : ''; return; }
    try { localStorage.setItem('skysentry.towerAirport', next); } catch {}
    const url = new URL(location.href);
    next ? url.searchParams.set('airport', next) : url.searchParams.delete('airport');
    location.assign(url);   // reconnect cleanly so feeds, map and alerts only carry this airport
  };
  input.addEventListener('change', choose);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') choose(); if (e.key === 'Escape') { input.value = view ? label(airports.find(a => a.code === view)) : ''; input.blur(); } });
  if (auth.airportRequired && !view) {
    $('airportHint').textContent = airports.length ? 'Select an airport to connect.' : 'No authorized airports are configured.';
  }
}

/* ---------- socket ---------- */
async function connect() {
  const status = text => { $('conn').textContent = text; };
  auth = await signIn({ role: 'dashboard', mount: $('auth'), onStatus: status });
  $('addCamera').hidden = auth.role === 'dashboard';   // tower accounts don't set up cameras; admins and keys still can
  if (auth.airport) view = auth.airport;
  if (!view) {
    status('Select an airport');
    await setupAirports();
    return;
  }
  if (!auth.airport) await setupAirports();
  let credentials = await auth.socketAuth({ airport: view });
  socket = io('/tower', { autoConnect: false, auth: cb => {
    if (credentials) { const data = credentials; credentials = null; cb(data); return; }
    auth.socketAuth({ airport: view }).then(cb).catch(err => { socket.disconnect(); showStartupError(err); });
  } });
  refreshSocketAuth(socket, auth);
  const activateMore = () => {
    if (!socket.connected || !$('more').open) return;
    void initChart().then(ready => { if (ready) void loadHourly(); });
  };
  $('more').addEventListener('toggle', activateMore);
  const feedEvents = new Map(), pendingFeed = new Map();
  const deliverFeed = (name, data) => {
    try { feedEvents.get(name)?.(data); }
    catch (err) {
      $('feedsHint').textContent = 'Could not render a camera update.';
      $('feedsHint').hidden = false;
      console.warn(err);
    }
  };
  for (const name of ['camera:config', 'bot:status', 'bot:state', 'camera:status', 'camera:frame', 'disconnect']) {
    socket.on(name, data => {
      if (feedEvents.has(name)) return deliverFeed(name, data);
      if (name === 'disconnect' || !data?.cameraId) return;
      const key = `${name}:${data.cameraId}`;
      pendingFeed.delete(key);
      pendingFeed.set(key, [name, data]);
      if (pendingFeed.size > 64) pendingFeed.delete(pendingFeed.keys().next().value);
    });
  }
  const initFeeds = feature('Camera feeds', 'feedsLoad', async () => {
    const { startFeeds } = await import('/js/feeds.js');
    const { VisualBirdVerifier } = await import('/js/visual-ai.js');
    const visualBirds = new VisualBirdVerifier({ button: $('birdCheck'), status: $('birdCheckStatus'), reviewStatus: $('birdReviewStatus') });
    api('/api/cloud-evidence-policy').then(({ cloudEvidenceEnabled }) => {
      if (cloudEvidenceEnabled === true) {
        visualBirds.judge = ref => api('/api/verify-bird', { method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(ref) });
      }
    }).catch(() => { /* An unknown policy means local-only. */ });
    startFeeds({
      on: (name, receive) => feedEvents.set(name, receive),
    }, { container: $('feeds'), hint: $('feedsHint'), demo: false,
      onFeed: t => visualBirds.onFeed(t), onRemove: id => visualBirds.feeds.delete(id),
    });
    for (const [name, data] of pendingFeed.values()) deliverFeed(name, data);
    pendingFeed.clear();
  });
  let started = false;
  socket.on('connect', () => {
    status('Live'); $('conn').dataset.ok = '1';
    for (const id of ['dashboard', 'sideRisk', 'cams']) $(id).hidden = false;
    monitoring.setConnected(true); refreshRisk();
    void loadIncidents();
    replayAlerts();
    activateMore();
    if (started) return;
    started = true;
    if (auth.airport) void setupAirports().catch(err => {
      $('airportBox').hidden = false; $('airportSearch').disabled = true;
      $('airportHint').textContent = `Airport picker unavailable: ${err.message}`;
    });
    void initMap();
    if (!$('addCamera').hidden) void initQR();
    // Loaded only after the authorized connection; the walkthrough is not a startup dependency.
    void loadAsset('script', '/js/walkthrough.js').catch(err => console.warn('Walkthrough unavailable:', err));
    void initFeeds();
  });
  socket.on('disconnect', reason => {
    historyRequest?.abort(); evidenceRequest?.abort(); pendingFeed.clear(); cameraPositions.clear();
    alertSyncGeneration++;
    if (evidenceUrl) { URL.revokeObjectURL(evidenceUrl); evidenceUrl = null; }
    if (selectedIncident) { $('detail').replaceChildren(); $('detail').hidden = true; selectedIncident = null; }
    monitoring.setConnected(false); refreshRisk();
    status(['io server disconnect', 'io client disconnect'].includes(reason)
      ? 'Access ended; reload to reconnect' : 'Reconnecting…');
    $('conn').dataset.ok = '0';
  });
  socket.on('connect_error', err => {
    if (err.message === 'unauthorized' || !socket.active) showStartupError(new Error('The tower did not authorize this connection.'));
    else status('Offline — reconnecting…');
    $('conn').dataset.ok = '0';
    monitoring.setConnected(false); refreshRisk();
  });
  socket.on('camera:status', packet => { if (monitoring.status(packet)) refreshRisk(); });
  socket.on('camera:heartbeat', packet => monitoring.heartbeat(packet));
  socket.on('camera:frame', packet => monitoring.heartbeat(packet));
  socket.on('bot:status', packet => { if (monitoring.mode(packet)) refreshRisk(); });
  socket.on('bot:state', packet => monitoring.detector(packet));
  socket.on('camera:event', packet => {
    const ev = monitoring.event(packet);
    if (!ev) return;
    feed(ev); refreshRisk();
    if (ev.camera) {
      cameraPositions.set(ev.cameraId, ev);
      if (cameraPositions.size > 64) cameraPositions.delete(cameraPositions.keys().next().value);
      try { layers?.placeCamera(ev); }
      catch (err) { $('mapNote').textContent = 'Some map markers could not be displayed.'; console.warn(err); }
    }
  });
  socket.on('incident', packet => { if (operational(packet) && packet.airport === view) updateIncidents([packet], 'live'); });
  socket.on('alert_pending', data => showAlert(data, { provisional: true }));
  socket.on('alert', showAlert);
  socket.on('alert_acknowledged', data => { if (scopedAlert(data)) acknowledgeAlert(data.id); });
  socket.on('alert_update', packet => { if (operational(packet)) announcements.update(packet); });
  socket.connect();
}
function showStartupError(err) {
  $('conn').textContent = 'Could not connect';
  for (const id of ['dashboard', 'sideRisk', 'cams', 'airportBox']) $(id).hidden = true;
  const card = panel($('auth'), '<h2>Could not open the tower</h2><p></p><button type="button">Retry</button> <a href="/tower.html?airport=">Select an airport</a>');
  card.querySelector('p').textContent = err.message;
  card.querySelector('button').onclick = () => location.reload();
}
setInterval(loadHourly, 30000);
setInterval(replayAlerts, 30000);
connect().catch(err => {
  if (err.message === 'wrong role') $('conn').textContent = 'Not allowed';
  else showStartupError(err);
});
