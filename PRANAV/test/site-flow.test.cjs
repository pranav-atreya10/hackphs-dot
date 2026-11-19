const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runInNewContext } = require('node:vm');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createReceiptSpool } = require('../receipt-spool');

const root = join(__dirname, '..');
let missing;
for (const name of ['express', 'compression', 'socket.io', 'sharp']) {
  try { require.resolve(name); } catch { missing = `missing application dependency: ${name}`; break; }
}

function fakeStorage() {
  const rows = new Map(), markers = new Map(), alertAttempts = [];
  const state = { fail: false, loseReply: false, rows, alertAttempts, onClose: async () => {} };
  const matches = (row, filter) => row && (filter.airport === undefined || row.airport === filter.airport) &&
    (!filter.alert || row.alert) && (!filter.acknowledged_at || Boolean(row.acknowledged_at) === filter.acknowledged_at.$exists) &&
    (!filter._id?.$gt || row._id > filter._id.$gt);
  const cursor = (values) => ({ sort() { return this; }, limit() { return this; }, async toArray() { return values(); } });
  state.client = class {
    db() {
      return { collection: name => ({
        async createIndex() {},
        listIndexes: () => cursor(() => [{ key: { time: 1 }, expireAfterSeconds: 8 * 86400 }]),
        async updateOne({ _id }, { $set }, options) {
          assert.equal(options.writeConcern.w, 'majority');
          assert.equal(_id, 'skysentry:readiness:v1');
          if (state.fail) throw new Error('test storage cannot perform majority writes');
          assert.equal(options.upsert, true);
          markers.set(name, { _id, ...$set });
          return { acknowledged: true };
        },
        async insertOne(row, options) {
          assert.equal(name, 'detections');
          assert.equal(options.writeConcern.w, 'majority');
          if (row.alert) alertAttempts.push(row._id);
          if (state.fail) throw new Error('test write failure');
          if (rows.has(row._id)) throw Object.assign(new Error('duplicate fixture receipt'), { code: 11000 });
          rows.set(row._id, structuredClone(row));
          if (row.alert && state.loseReply) {
            state.loseReply = false;
            throw new Error('test reply lost after commit');
          }
          return { acknowledged: true };
        },
        async findOne(filter, options) {
          if (name === 'role_requests') return null;
          assert.equal(options.readConcern.level, 'majority');
          if (filter.marker) return markers.get(name)?.marker === filter.marker ? markers.get(name) : null;
          const row = rows.get(filter._id);
          return matches(row, filter) ? row : null;
        },
        find(filter, options) {
          if (name === 'airports') return cursor(() => []);
          if (name === 'incidents') return cursor(() => []);
          assert.equal(options.readConcern.level, 'majority');
          assert.equal(filter.$expr.$eq[1], filter.airport);
          return cursor(() => {
            if (state.fail) throw new Error('test majority read outage');
            return [...rows.values()].filter(row => matches(row, filter));
          });
        },
        async findOneAndUpdate(filter, update, options) {
          assert.equal(options.writeConcern.w, 'majority');
          if (!filter._id) return null; // No enrichment worker claims in this integration fixture.
          const row = rows.get(filter._id);
          if (!matches(row, filter)) return null;
          row.acknowledged_at ??= new Date();
          row.acknowledged_by ??= update[0].$set.acknowledged_by.$ifNull[1].$literal;
          return row;
        },
      }) };
    }
    async close() { await state.onClose(); }
  };
  return state;
}

async function boot(t, storage, spoolPath) {
  const { Server } = require('socket.io');
  // Use the real, bundled Socket.IO browser client and local HTTP/WebSocket transports.
  const client = require(join(require.resolve('socket.io'), '..', '..', 'client-dist', 'socket.io.js')).io;
  const timers = new Set(), sockets = new Set();
  let server, shutdown, exitCode, stopping;
  const overrides = {
    http: { createServer(app) {
      server = http.createServer(app);
      const listen = server.listen.bind(server);
      server.listen = (_port, _host, callback) => listen(0, '127.0.0.1', callback);
      return server;
    } },
    'socket.io': { Server },
    mongodb: { MongoClient: storage.client },
    '@clerk/express': {
      createClerkClient: () => ({
        users: { getCount: async () => 2, getUser: async () => ({
          emailAddresses: [{ emailAddress: 'admin@example.invalid', verification: { status: 'verified' } }],
        }) },
        sessions: { getSession: async sid => ({ status: 'active', userId: sid }) },
      }),
      verifyToken: async token => ({ sub: token, sid: token }),
    },
    './ai-voice/pipeline': { createPipeline: () => ({
      health: () => ({ gemini: { state: 'failing', failure: 'service' } }), status: () => ({ solana: 'failing' }),
    }) },
    './ai-voice/ai': { cloudEvidenceEnabled: false, analyzeEvent: () => assert.fail('unexpected provider call') },
    './ai-voice/solana': { createSolana: () => ({ stampReport: () => assert.fail('unexpected Solana write') }) },
    './ai-voice/chat': { createChat: () => ({ health: () => ({ configured: false }) }), createRequestLimit: () => () => true },
  };
  runInNewContext(await fs.readFile(join(root, 'server.js'), 'utf8'), {
    __dirname: root,
    require: name => overrides[name] ?? require(name.startsWith('.') ? join(root, name) : name),
    process: {
      env: {
        PORT: '0', NODE_ENV: 'test', MONGODB_URI: 'mongodb://test.invalid',
        CAMERA_API_KEY: 'test-camera-key', CAMERA_API_AIRPORT: 'KAAA', AIRPORT_CODES: 'KAAA=test-a,KBBB=test-b',
        CLERK_SECRET_KEY: 'test-clerk', CLERK_PUBLISHABLE_KEY: 'test-ui', ADMIN_EMAILS: 'admin@example.invalid',
        RECEIPT_SPOOL_FILE: spoolPath,
      },
      loadEnvFile() {}, uptime: () => 1,
      once(name, fn) { assert.equal(name, 'SIGTERM'); shutdown = fn; },
      exit(code) { exitCode = code; },
    },
    Buffer, setTimeout, clearInterval,
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    console: { log() {}, warn() {}, error() {} },
  });
  const stop = () => stopping ??= (async () => {
    for (const socket of sockets) socket.disconnect();
    for (const timer of timers) clearInterval(timer);
    await shutdown();
    assert.equal(exitCode, 0);
  })();
  t.after(stop);
  if (!server.address()) await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers) => fetch(url + path, { headers, signal: AbortSignal.timeout(8000) });
  const tower = async (airport, token = 'operator-one') => {
    const socket = client(url + '/tower', { auth: { token, airport }, forceNew: true,
      transports: ['websocket'], reconnection: false, autoConnect: false });
    sockets.add(socket);
    const connected = new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
    socket.connect();
    return connected;
  };
  const device = randomUUID(), session = randomUUID();
  const post = (path, body, extraHeaders) => fetch(url + path, {
    method: 'POST', body, signal: AbortSignal.timeout(8000), headers: {
      'x-api-key': 'test-camera-key', 'x-airport': 'KAAA', 'x-camera-device': device,
      'x-camera-session': session, 'x-camera-source': 'live', ...extraHeaders,
    },
  });
  return { get, tower, post, stop, device };
}

async function until(read, predicate) {
  for (let i = 0; i < 180; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(25);
  }
  assert.fail('Timed out waiting for the synthetic flow');
}
const ask = (socket, event, ...args) => socket.timeout(4000).emitWithAck(event, ...args);

test('real loopback camera-to-tower warnings, restart recovery, majority ACK and scoped reconnect', { skip: missing, timeout: 30000 }, async t => {
  const { SyntheticSky } = await import('../public/detection/index.js');
  const { createTowerMonitoring } = await import('../public/js/tower-monitoring.mjs');
  const { cameraIdentity } = require('../camera-ingress');
  const { createHash } = require('node:crypto');
  const sharp = require('sharp');
  const local = await fs.mkdtemp(join(tmpdir(), 'skysentry-flow-'));
  t.after(() => fs.rm(local, { recursive: true, force: true }));
  const spoolPath = join(local, 'spool');
  await fs.writeFile(spoolPath, '', { flag: 'wx', mode: 0o600 });
  const storage = fakeStorage();
  storage.fail = true;
  const first = await boot(t, storage, spoolPath);
  let clientElapsed = 0;
  const monitor = createTowerMonitoring(() => Date.now() + clientElapsed);
  monitor.setConnected(true);
  const health = await first.get('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).gemini.failure, 'service');
  const unready = await first.get('/ready');
  assert.equal(unready.status, 503);
  assert.equal((await unready.json()).checks.receipt_storage, 'unavailable');
  const airports = await first.get('/api/airports', { Authorization: 'Bearer operator-one' });
  assert.deepEqual((await airports.json()).airports.map(a => a.code), ['KAAA', 'KBBB']);
  await assert.rejects(first.tower(undefined), /unauthorized/);
  const a = await first.tower('KAAA'), b = await first.tower('KBBB');
  const received = [], other = [], alerts = [], detectorPackets = [];
  a.on('camera:status', packet => monitor.status(packet));
  a.on('bot:status', packet => monitor.mode(packet));
  a.on('bot:state', packet => { detectorPackets.push(packet); monitor.detector(packet); });
  a.on('camera:event', packet => { received.push(packet); monitor.event(packet); });
  a.on('alert_pending', data => alerts.push(data));
  b.on('camera:event', packet => other.push(packet));
  const sky = new SyntheticSky({ width: 640, height: 480, scenario: 'flock_corridor', seed: 7 });
  const principal = 'camera:' + createHash('sha256').update('test-camera-key').digest('hex');
  const cameraId = cameraIdentity({ airport: 'KAAA', principal }, 'http', first.device);
  const config = { source: 'live' };
  assert.equal((await first.post('/api/camera-config', JSON.stringify(config), {
    'content-type': 'application/json', 'x-airport': 'KBBB',
  })).status, 403);
  assert.equal((await first.post('/api/camera-config', JSON.stringify(config), { 'content-type': 'application/json' })).status, 200);
  for (let i = 0; i < 90 && !alerts.some(row => row.fresh); i++) {
    const frame = sky.render(i / 15);
    const jpeg = await sharp(frame.data, { raw: { width: 640, height: 480, channels: 4 } }).jpeg({ quality: 60 }).toBuffer();
    const res = await first.post('/api/camera-frame', jpeg, { 'content-type': 'image/jpeg', 'x-frame-time': String(i / 15) });
    assert.equal(res.status, 200);
  }
  const warning = await until(() => alerts.find(row => row.fresh), Boolean);
  assert.equal(warning.airport, 'KAAA');
  assert.equal(warning.storage_state, 'pending');
  assert.ok(received.some(row => row.id === warning.id && row.cameraId === cameraId && row.risk === 'red'));
  assert.equal(monitor.snapshot().level, 'red');
  assert.deepEqual(other, []);
  clientElapsed = 3100;
  assert.equal(monitor.snapshot().coverage, 'degraded');
  assert.notEqual(monitor.snapshot().level, 'green');
  clientElapsed = 11_000;
  assert.equal(monitor.snapshot().level, 'unavailable');
  await until(() => alerts.find(row => row.id === warning.id && row.storage_state === 'retrying'), Boolean);
  assert.deepEqual(await ask(a, 'alert:acknowledge', warning.id), { ok: false });
  let checkpointSeen = false;
  storage.onClose = async () => { checkpointSeen = (await createReceiptSpool(spoolPath).rows())
    .some(row => row.alert?.id === warning.id && !row.job.evidence); };
  await first.stop();
  assert.equal(checkpointSeen, true, 'the checkpoint is readable before Mongo closes');
  storage.onClose = async () => {};
  const restarted = await boot(t, storage, spoolPath);
  const recoveredTower = await restarted.tower('KAAA');
  const replayWhileOffline = await ask(recoveredTower, 'alert:replay', null);
  assert.equal(replayWhileOffline.ok, false);
  assert.ok(replayWhileOffline.pending.some(({ alert, state }) => alert?.id === warning.id && state === 'retrying' && !alert.fresh));
  assert.deepEqual((await ask(await restarted.tower('KBBB'), 'alert:replay', null)).pending, []);
  const late = new Promise(resolve => recoveredTower.on('alert', row => { if (row.id === warning.id) resolve(row); }));
  storage.loseReply = true;
  storage.fail = false;
  const stored = await Promise.race([late, delay(5500, null, { ref: false }).then(() => assert.fail('No stored receipt after reconnect'))]);
  assert.equal(stored.fresh, undefined);
  assert.ok(storage.alertAttempts.filter(id => id === warning.id).length > 1);
  const replay = await ask(recoveredTower, 'alert:replay', null);
  assert.equal(replay.ok, true);
  assert.equal(replay.alerts.filter(row => row.id === warning.id).length, 1);
  const persisted = storage.rows.get(warning.id);
  assert.equal(persisted.camera_id, cameraId);
  const { streamId, frameId, generation, t: captureTime } = persisted.enrichment.incident.detection;
  assert.ok(detectorPackets.some(packet => packet.cameraId === cameraId && packet.streamId === streamId &&
    packet.frameId === frameId && packet.state.generation === generation && packet.state.t === captureTime));
  assert.equal(persisted.enrichment.evidence, null);
  assert.deepEqual(await ask(recoveredTower, 'alert:acknowledge', warning.id), { ok: true });
  recoveredTower.disconnect();
  const secondOperator = await restarted.tower('KAAA', 'operator-two');
  assert.deepEqual(await ask(secondOperator, 'alert:acknowledge', warning.id), { ok: true });
  assert.equal(storage.rows.get(warning.id).acknowledged_by, 'operator-one');
  assert.ok(!(await ask(secondOperator, 'alert:replay', null)).alerts.some(row => row.id === warning.id));
  await until(() => createReceiptSpool(spoolPath).rows(), rows => !rows.some(row => row.record.id === warning.id));
  assert.equal((await restarted.get('/ready')).status, 200, 'optional provider failure is not a readiness gate');
  await restarted.stop();
});

test('healthy Mongo without a persistent spool cannot make the listening server ready', { skip: missing, timeout: 10000 }, async t => {
  const app = await boot(t, fakeStorage());
  const live = await app.get('/health');
  assert.equal(live.status, 200);
  const ready = await app.get('/ready');
  assert.equal(ready.status, 503);
  const { checks } = await ready.json();
  assert.equal(checks.receipt_storage, 'ready');
  assert.equal(checks.video_detector, 'ready');
  assert.equal(checks.receipt_recovery, 'not_configured');
});
