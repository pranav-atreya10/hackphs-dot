// fake-events.js: pretends to be a camera AND a tower, so the whole alert path can be tested
// with no real camera and no tower page.
//   Camera side: connects to /camera and sends one red bird event, then one drone event 4 s later.
//   Tower side:  connects to /tower and prints every alert / alert_update the server sends back.
// Usage, from inside SHREYANSH/:  node fake-events.js [serverUrl]    (default http://localhost:8080)
// The server's rate limit allows one alert per type every 12 s, so wait 12 s between runs.
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const config = require('./config');

const SERVER = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const DRONE_DELAY_MS = 4000;  // gap between the bird event and the drone event
const MAX_WAIT_MS = 25000;    // give up waiting for updates after this
const started = Date.now();
const secs = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

// A small real JPEG (eight drawn birds over a runway), sent as bare base64 like the camera page does.
const snapshot = fs.readFileSync(path.join(__dirname, 'fixtures', 'sky-birds.jpg')).toString('base64');

const birdEvent = { camera_id: 'runway-east', type: 'bird', object_count: 8, direction: 'toward runway', confidence: 0.86, risk: 'red', snapshot };
const droneEvent = { camera_id: 'runway-east', type: 'drone', object_count: 1, direction: 'unknown', confidence: 0.91, risk: 'red', snapshot };

// What the tower has received, merged by alert id (the same way a real tower should do it).
const alerts = new Map();
let relayedEvents = 0;

// ---------- tower side ----------
const tower = io(`${SERVER}/tower`, { auth: { key: config.TOWER_API_KEY || undefined }, reconnection: false });
tower.on('camera:event', () => { relayedEvents++; });
tower.on('alert', a => {
  alerts.set(a.id, { ...a });
  console.log(`[tower]  ${secs()} alert         ${a.risk} ${a.type}: "${a.text}"`);
});
tower.on('alert_update', u => {
  const a = Object.assign(alerts.get(u.id) || { id: u.id }, u);
  alerts.set(u.id, a);
  if (u.audio) console.log(`[tower]  ${secs()} alert_update  ${a.type}: audio, ${Buffer.from(u.audio, 'base64').length} byte mp3`);
  if (u.audio_failed) console.log(`[tower]  ${secs()} alert_update  ${a.type}: audio_failed (tower would use its own voice)`);
  if (u.report) console.log(`[tower]  ${secs()} alert_update  ${a.type}: ${u.report_source} report, label "${u.label}"`);
  if (u.solana_tx) console.log(`[tower]  ${secs()} alert_update  ${a.type}: Solana stamp ${u.solana_url}`);
});
tower.on('connect_error', err => fail(`tower could not connect to ${SERVER}/tower: ${explain(err)}`));
// Start the camera only once the tower is listening, so no alert is missed.
tower.on('connect', () => {
  console.log(`[tower]  ${secs()} connected to ${SERVER}/tower`);
  camera.connect();
});

// ---------- camera side ----------
// forceNew: its own connection, like a real camera on a different device. (Sharing one connection
// with the tower socket made the server drop the camera.)
const camera = io(`${SERVER}/camera`, {
  auth: { key: config.CAMERA_API_KEY || undefined, cameraId: 'fake-camera' },
  reconnection: false, autoConnect: false, forceNew: true
});
camera.on('connect_error', err => fail(`camera could not connect to ${SERVER}/camera: ${explain(err)}`));
camera.on('connect', async () => {
  console.log(`[camera] ${secs()} connected to ${SERVER}/camera`);
  await send(birdEvent);
  setTimeout(async () => {
    await send(droneEvent);
    waitForUpdates();
  }, DRONE_DELAY_MS);
});

async function send(event) {
  try {
    const ack = await camera.timeout(5000).emitWithAck('camera:event', { ...event, time: new Date().toISOString() });
    console.log(`[camera] ${secs()} sent ${event.type} (${event.object_count}, ${event.direction}, ${event.risk}) -> server ack: ${ack && ack.ok ? 'ok' : JSON.stringify(ack)}`);
  } catch {
    console.log(`[camera] ${secs()} sent ${event.type}, but the server did not acknowledge within 5 s`);
  }
}

// Turns socket errors into a plain hint.
function explain(err) {
  if (err.message === 'unauthorized') return 'unauthorized. The key in SHREYANSH/.env (CAMERA_API_KEY or TOWER_API_KEY) does not match the server.';
  return `${err.message}. Is the server running at ${SERVER}?`;
}

function fail(message) {
  console.log(`FAILED  ${message}`);
  process.exit(1);
}

// An alert is complete once it has a report and a voice result (audio or audio_failed).
// Drones may also get a Solana stamp, so allow a few extra seconds for that.
function waitForUpdates() {
  const complete = a => a.report && (a.risk !== 'red' || a.audio || a.audio_failed);
  const timer = setInterval(() => {
    const all = [...alerts.values()];
    const done = all.length >= 2 && all.every(complete);
    if (done || Date.now() - started > MAX_WAIT_MS) {
      clearInterval(timer);
      setTimeout(summary, done ? 5000 : 0);
    }
  }, 250);
}

function summary() {
  const all = [...alerts.values()];
  const byType = type => all.find(a => a.type === type);
  let failures = 0;
  const check = (ok, what) => { if (!ok) failures++; console.log(`  ${ok ? 'OK    ' : 'FAILED'}  ${what}`); };

  console.log('\nSummary:');
  check(relayedEvents >= 2, `server relayed camera events to the tower (${relayedEvents})`);
  for (const type of ['bird', 'drone']) {
    const a = byType(type);
    check(Boolean(a), `${type}: "alert" received`);
    if (!a) continue;
    check(Boolean(a.audio || a.audio_failed), `${type}: voice result (${a.audio ? 'ElevenLabs audio' : a.audio_failed ? 'audio_failed, browser voice' : 'none'})`);
    check(Boolean(a.report), `${type}: report (${a.report_source || 'none'})`);
  }
  const drone = byType('drone');
  console.log(`  info    drone Solana stamp: ${drone && drone.solana_tx ? drone.solana_url : 'none (needs a funded devnet wallet: node check-wallet.js)'}`);
  if (!all.length && relayedEvents) {
    console.log('\nThe server relays events but sends no alerts: the pipeline snippet is not wired into the server,');
    console.log('or an alert of the same type went out in the last 12 s.');
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OK');
  camera.close();
  tower.close();
  process.exit(failures ? 1 : 0);
}
