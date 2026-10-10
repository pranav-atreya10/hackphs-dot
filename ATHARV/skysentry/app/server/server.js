// SkySentry API server: Node + Express + Socket.IO, deployable on DigitalOcean App Platform (prompt B1).
// Serves the camera page (/camera) and the tower dashboard (/tower) from the same origin.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { config, modeSummary } from './config.js';
import { openStores } from './db.js';
import { createPipeline } from './pipeline.js';
import { answerQuestion } from './ai.js';

const dir = p => fileURLToPath(new URL(p, import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 2e6, cors: { origin: process.env.CORS_ORIGIN ?? false } });

const stores = await openStores();
const pipeline = createPipeline({ stores, emit: (name, data) => io.to('tower').emit(name, data) });

app.use(express.json({ limit: '1mb' }));
app.use('/camera', express.static(dir('../camera')));
app.use('/tower', express.static(dir('../tower')));
app.use('/shared', express.static(dir('../shared')));
app.get('/', (_req, res) => res.redirect('/tower/'));

app.get('/api/health', (_req, res) => res.json({ ok: true, modes: modeSummary(), cameras: [...cameras.values()] }));

// Prompt B2: hourly rows for the last 24 hours (or ?hours=N, max 168).
app.get('/api/hourly', async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  try { res.json(await stores.detections.hourly(hours)); }
  catch (err) { res.status(500).json({ error: 'Could not read hourly stats', detail: err.message }); }
});

// Prompt B3: latest 20 incident reports, newest first (snapshots left out; fetch one by id).
app.get('/api/incidents', async (_req, res) => {
  try { res.json(await stores.incidents.latest(20)); }
  catch (err) { res.status(500).json({ error: 'Could not read incidents', detail: err.message }); }
});
app.get('/api/incidents/:id', async (req, res) => {
  try { const d = await stores.incidents.get(req.params.id); d ? res.json(d) : res.status(404).json({ error: 'No incident with that id' }); }
  catch (err) { res.status(400).json({ error: 'Invalid incident id', detail: err.message }); }
});

// HTTP fallback for cameras that cannot hold a socket open.
app.post('/api/events', async (req, res) => {
  const r = await pipeline.handle(req.body);
  res.status(r.ok ? 202 : 400).json(r);
});

// Prompt A4: answer a question using only the last 7 days of hourly stats.
app.post('/api/ask', async (req, res) => {
  const q = String(req.body?.question ?? '').trim().slice(0, 500);
  if (!q) return res.status(400).json({ error: 'Type a question first.' });
  res.json(await answerQuestion(q, await stores.detections.hourly(168).catch(() => [])));
});

// Socket.IO: cameras send `camera:event`; towers join the `tower` room and receive
// `detection` (every event), `incident` (new report) and `alert` (red, with audio).
const cameras = new Map();
io.on('connection', socket => {
  socket.on('tower:join', () => { socket.join('tower'); socket.emit('cameras', [...cameras.values()]); });
  socket.on('camera:hello', ({ camera_id }) => {
    socket.data.cameraId = camera_id;
    cameras.set(camera_id, { camera_id, connected_at: new Date().toISOString() });
    io.to('tower').emit('cameras', [...cameras.values()]);
  });
  socket.on('camera:event', async (event, ack) => {
    const r = await pipeline.handle(event).catch(err => ({ ok: false, errors: [err.message] }));
    if (typeof ack === 'function') ack(r.ok ? { ok: true } : r);
  });
  socket.on('disconnect', () => {
    if (socket.data.cameraId) { cameras.delete(socket.data.cameraId); io.to('tower').emit('cameras', [...cameras.values()]); }
  });
});

http.listen(config.port, () => {
  console.log(`SkySentry server on http://localhost:${config.port}`);
  console.log(`  tower:  http://localhost:${config.port}/tower/`);
  console.log(`  camera: http://localhost:${config.port}/camera/`);
  console.log(`  ${modeSummary()}`);
});

const shutdown = async () => { await stores.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
