// Tower dashboard (prompts T1-T4): risk meter and alert feed over Socket.IO, alarm + voice for
// red alerts, Leaflet airport map with alert pins, hourly Chart.js bars, incident list, chat.

// Airport and camera placement. Adjust to the real runway and where the camera points.
const AIRPORT = { name: 'Princeton Airport', lat: 40.3986, lng: -74.6585, zoom: 16 };
const CAMERAS = { 'runway-east': { lat: 40.3981, lng: -74.6560, bearing: 330, range: 350 } };

const $ = id => document.getElementById(id);
const socket = io();
const RANK = { green: 0, yellow: 1, red: 2 };
let soundOn = false, audioCtx = null, currentRisk = 'green', riskTimer = null;

/* ---------- sound: alarm tone, then ElevenLabs audio or the browser's voice ---------- */
$('sound').addEventListener('click', () => {
  soundOn = !soundOn; $('sound').dataset.on = soundOn ? '1' : '';
  $('sound').textContent = soundOn ? 'Alert sound on' : 'Turn on alert sound';
  if (soundOn) { audioCtx ??= new AudioContext(); audioCtx.resume(); }
});
function alarm() {
  if (!soundOn || !audioCtx) return Promise.resolve();
  const t = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t + i * 0.28); g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.28 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.28 + 0.24);
    o.connect(g).connect(audioCtx.destination); o.start(t + i * 0.28); o.stop(t + i * 0.28 + 0.26);
  }
  return new Promise(r => setTimeout(r, 900));
}
async function announce({ text, audio }) {
  await alarm();
  if (!soundOn) return;
  if (audio) { new Audio(`data:audio/mpeg;base64,${audio}`).play().catch(() => {}); return; }
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; speechSynthesis.speak(u); }
}

/* ---------- risk meter ---------- */
function setRisk(risk, what, when) {
  // Hold a yellow or red level for 10 s so a single green heartbeat doesn't hide it.
  if (RANK[risk] < RANK[currentRisk] && riskTimer) return;
  currentRisk = risk; $('meter').dataset.risk = risk; $('riskLabel').textContent = risk.toUpperCase();
  $('riskWhat').textContent = what; $('riskWhen').textContent = when;
  clearTimeout(riskTimer); riskTimer = risk === 'green' ? null : setTimeout(() => { riskTimer = null; }, 10000);
}
const time = iso => new Date(iso).toLocaleTimeString('en-US', { hour12: false });

/* ---------- map ---------- */
const map = L.map('map', { scrollWheelZoom: false }).setView([AIRPORT.lat, AIRPORT.lng], AIRPORT.zoom);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const offset = (lat, lng, bearingDeg, meters) => {
  const b = bearingDeg * Math.PI / 180, dLat = meters * Math.cos(b) / 111320, dLng = meters * Math.sin(b) / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat + dLat, lng + dLng];
};
for (const [id, c] of Object.entries(CAMERAS)) {
  L.circleMarker([c.lat, c.lng], { radius: 7, color: '#1f6fd1', fillOpacity: 1 }).addTo(map).bindTooltip(`Camera ${id}`);
  const cone = [[c.lat, c.lng]]; for (let a = -25; a <= 25; a += 5) cone.push(offset(c.lat, c.lng, c.bearing + a, c.range));
  L.polygon(cone, { color: '#c2643f', weight: 1, fillOpacity: 0.15 }).addTo(map);
}
function pin(inc) {
  const c = CAMERAS[inc.camera_id]; if (!c) return;
  const at = offset(c.lat, c.lng, c.bearing + (Math.random() - 0.5) * 30, c.range * (0.4 + Math.random() * 0.5));
  L.circleMarker(at, { radius: 8, color: inc.risk === 'red' ? '#c0392b' : '#d99a00', fillOpacity: 0.85 }).addTo(map)
    .bindPopup(`<b>${inc.type === 'drone' ? 'Drone' : `${inc.object_count} birds`}</b><br>${time(inc.time)} · ${inc.risk}`);
}

/* ---------- live feed ---------- */
function feed(e) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${time(e.time)}</span><span class="lvl ${e.risk}">${e.risk}</span><span></span>`;
  li.lastChild.textContent = `${e.camera_id} · ${e.type} · ${e.object_count} · ${e.direction}`;
  $('feed').prepend(li); while ($('feed').children.length > 60) $('feed').lastChild.remove();
}

/* ---------- incidents ---------- */
function incidentItem(inc) {
  const li = document.createElement('li'), b = document.createElement('button');
  b.innerHTML = '<b></b><span></span>';
  b.firstChild.textContent = `${inc.risk === 'red' ? 'Red' : 'Yellow'} · ${inc.type === 'drone' ? 'Drone' : `${inc.object_count} birds`} · ${inc.camera_id}`;
  b.lastChild.textContent = `${new Date(inc.time).toLocaleString()}${inc.solana_tx ? ' · stamped on Solana' : ''}`;
  b.addEventListener('click', () => showIncident(inc._id));
  li.appendChild(b); return li;
}
async function loadIncidents() {
  const list = await fetch('/api/incidents').then(r => r.json()).catch(() => []);
  $('incidents').replaceChildren(...list.map(incidentItem));
}
async function showIncident(id) {
  if (!id) return;
  const d = await fetch(`/api/incidents/${id}`).then(r => r.json());
  const box = $('detail'); box.hidden = false; box.replaceChildren();
  const img = document.createElement('img'); img.alt = 'Snapshot from the camera';
  if (d.snapshot) img.src = `data:image/jpeg;base64,${d.snapshot}`;
  const text = document.createElement('div'); text.style.display = 'grid'; text.style.gap = '6px';
  const label = document.createElement('p'); label.innerHTML = '<b>Gemini sees:</b> '; label.append(d.gemini_label ?? '—');
  const report = document.createElement('p'); report.textContent = d.report;
  text.append(label, report);
  if (d.solana_tx) { const a = document.createElement('a'); a.href = `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View the Solana stamp'; text.append(a); }
  box.append(img, text);
}

/* ---------- hourly chart (refreshes every 30 s) ---------- */
const chart = new Chart($('chart'), {
  type: 'bar',
  data: { labels: [], datasets: [{ label: 'Birds', data: [], backgroundColor: '#c2643f' }, { label: 'Drones', data: [], backgroundColor: '#1f1b16' }] },
  options: { animation: false, responsive: true, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { labels: { boxWidth: 12 } } } }
});
async function loadHourly() {
  const rows = await fetch('/api/hourly').then(r => r.json()).catch(() => []);
  const hours = [...new Set(rows.map(r => r.hour))].sort();
  const val = (h, type) => rows.find(r => r.hour === h && r.type === type)?.total_objects ?? 0;
  chart.data.labels = hours.map(h => new Date(h).toLocaleTimeString('en-US', { hour: 'numeric' }));
  chart.data.datasets[0].data = hours.map(h => val(h, 'bird'));
  chart.data.datasets[1].data = hours.map(h => rows.find(r => r.hour === h && r.type === 'drone')?.events ?? 0);
  chart.update();
}

/* ---------- Ask SkySentry ---------- */
$('ask').addEventListener('submit', async e => {
  e.preventDefault();
  const question = $('q').value.trim(); if (!question) return;
  $('answer').textContent = 'Thinking…';
  const r = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) }).then(r => r.json()).catch(() => ({ answer: 'The server is not responding.' }));
  $('answer').textContent = r.answer ?? r.error;
});

/* ---------- socket wiring ---------- */
socket.on('connect', () => { $('conn').textContent = 'Live'; $('conn').dataset.ok = '1'; socket.emit('tower:join'); loadIncidents(); loadHourly(); });
socket.on('disconnect', () => { $('conn').textContent = 'Offline'; $('conn').dataset.ok = ''; });
socket.on('cameras', list => { $('cams').textContent = list.length ? `${list.length} camera${list.length > 1 ? 's' : ''}: ${list.map(c => c.camera_id).join(', ')}` : 'No cameras'; });
socket.on('detection', e => {
  feed(e);
  const what = e.risk === 'green' ? 'Clear sky' : e.type === 'drone' ? 'Drone detected' : `${e.object_count} bird${e.object_count === 1 ? '' : 's'} · ${e.direction}`;
  setRisk(e.risk, what, `${e.camera_id} · ${time(e.time)}`);
});
socket.on('incident', inc => { $('incidents').prepend(incidentItem(inc)); pin(inc); });
socket.on('alert', a => { $('alertText').textContent = a.text; announce(a); });
setInterval(loadHourly, 30000);
