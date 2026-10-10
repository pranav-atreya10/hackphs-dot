// Camera station loop: detect -> track -> score risk -> send to the server (prompts D1-D4).
import { BirdTracker } from '/shared/tracker.js';
import { classifyRisk, DroneGate } from '/shared/risk.js';
import { makeEvent } from '/shared/event.js';
import { createDetector } from './detect.js';
import { createListener } from './sound.js';

const $ = id => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const snapCanvas = document.createElement('canvas');
const socket = window.io ? window.io() : null;

const tracker = new BirdTracker();
const drone = new DroneGate();
let detector = null, listener = null, running = false, lastSent = 0, lastRisk = 'green', droneScore = 0;
const HEARTBEAT_MS = 2000;

function log(msg) {
  const li = document.createElement('li'); li.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $('log').prepend(li); while ($('log').children.length > 30) $('log').lastChild.remove();
}

function snapshot() {
  const w = 320, h = Math.round(w * (video.videoHeight || 480) / (video.videoWidth || 640));
  snapCanvas.width = w; snapCanvas.height = h;
  snapCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return snapCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
}

function send(event) {
  if (!socket?.connected) { log(`offline · ${event.type} ${event.risk}`); return; }
  socket.emit('camera:event', event, r => { if (r && !r.ok) log(`rejected: ${r.errors.join('; ')}`); });
  log(`sent · ${event.type} · ${event.object_count} · ${event.direction} · ${event.risk.toUpperCase()}`);
}

function draw(result, risk) {
  overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;
  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(194,100,63,.10)'; ctx.fillRect(0, 0, W * tracker.runwaySide, H);
  ctx.setLineDash([8, 6]); ctx.strokeStyle = 'rgba(194,100,63,.8)'; ctx.beginPath(); ctx.moveTo(W * tracker.runwaySide, 0); ctx.lineTo(W * tracker.runwaySide, H); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '600 13px system-ui'; ctx.lineWidth = 2;
  for (const t of result.tracks) {
    const b = t.box, color = t.heading === 'toward runway' ? '#c0392b' : '#1f6fd1';
    ctx.strokeStyle = color; ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.fillStyle = color; ctx.fillText(`#${t.id} ${Math.round(b.score * 100)}%`, b.x, b.y - 4);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2, k = W * 12;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + t.vx * k, cy + t.vy * k); ctx.stroke();
  }
  $('meter').dataset.risk = risk.risk;
  $('riskLabel').textContent = risk.risk.toUpperCase();
  $('riskReason').textContent = risk.reason;
  $('birdCount').textContent = result.count;
  $('droneScore').textContent = droneScore.toFixed(2);
  $('droneAlert').hidden = !drone.heard;
}

async function tick() {
  if (!running) return;
  const now = performance.now();
  try {
    const boxes = video.readyState >= 2 ? await detector.detect(video) : [];
    const result = tracker.update(boxes, video.videoWidth || 640);
    drone.update(droneScore, now);
    const risk = classifyRisk({ birdCount: result.count, anyTowardRunway: result.anyTowardRunway, droneHeard: drone.heard });
    draw(result, risk);

    // Every 2 seconds, and immediately whenever risk turns yellow or red (prompt D4).
    const escalated = risk.risk !== 'green' && risk.risk !== lastRisk;
    if (now - lastSent >= HEARTBEAT_MS || escalated) {
      const cameraId = $('cameraId').value.trim() || 'runway-east';
      const snap = risk.risk !== 'green' ? snapshot() : undefined;
      const best = result.tracks.reduce((m, t) => Math.max(m, t.box.score), 0);
      send(makeEvent({ cameraId, type: 'bird', count: result.count, direction: result.direction,
        confidence: best, risk: drone.heard ? classifyRisk({ birdCount: result.count, anyTowardRunway: result.anyTowardRunway }).risk : risk.risk, snapshot: snap }));
      if (drone.heard) send(makeEvent({ cameraId, type: 'drone', count: 1, direction: 'unknown', confidence: droneScore, risk: 'red', snapshot: snap }));
      lastSent = now;
    }
    lastRisk = risk.risk;
  } catch (err) { log(`detector error: ${err.message}`); }
  requestAnimationFrame(tick);
}

async function startSource() {
  const file = $('clip').files[0];
  if (file) { video.srcObject = null; video.src = URL.createObjectURL(file); video.loop = true; }
  else video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 1280, height: 720 }, audio: false });
  await video.play();
}

$('start').addEventListener('click', async () => {
  if (running) { running = false; listener?.stop(); $('start').textContent = 'Start'; log('stopped'); return; }
  $('start').disabled = true;
  try {
    await startSource();
    detector = await createDetector($('detector').value); log(`loading ${detector.name}…`); await detector.load();
    listener = createListener($('sound').value, $('modelUrl').value.trim()); await listener.load();
    await listener.start(s => { droneScore = s.drone; });
    tracker.reset(); running = true; $('start').textContent = 'Stop'; log(`running · ${detector.name} · ${listener.name}`);
    requestAnimationFrame(tick);
  } catch (err) { log(`could not start: ${err.message}`); }
  $('start').disabled = false;
});

socket?.on('connect', () => { $('conn').textContent = 'Connected to server'; $('conn').dataset.ok = '1'; socket.emit('camera:hello', { camera_id: $('cameraId').value.trim() || 'runway-east' }); });
socket?.on('disconnect', () => { $('conn').textContent = 'Server offline'; $('conn').dataset.ok = ''; });
if (!socket) $('conn').textContent = 'Socket.IO not loaded; is the server running?';
