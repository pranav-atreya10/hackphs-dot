// Sends a scripted sequence of camera events to a running server, so the tower can be
// tested without a camera: clear sky, a few birds, a flock toward the runway, then a drone.
// Usage: npm run simulate            (server at http://localhost:8080)
//        SERVER=http://host:port npm run simulate
import { makeEvent } from '../shared/event.js';

const SERVER = process.env.SERVER ?? `http://localhost:${process.env.PORT ?? 8080}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 1x1 grey JPEG so yellow/red events carry a snapshot like the real camera does.
const SNAP = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const script = [
  ...Array(3).fill({ type: 'bird', count: 0, direction: 'unknown', confidence: 0, risk: 'green' }),
  { type: 'bird', count: 3, direction: 'crossing', confidence: 0.81, risk: 'yellow' },
  { type: 'bird', count: 3, direction: 'crossing', confidence: 0.83, risk: 'yellow' },
  { type: 'bird', count: 8, direction: 'toward runway', confidence: 0.9, risk: 'red' },
  { type: 'bird', count: 8, direction: 'toward runway', confidence: 0.88, risk: 'red' },
  ...Array(2).fill({ type: 'bird', count: 0, direction: 'unknown', confidence: 0, risk: 'green' }),
  { type: 'drone', count: 1, direction: 'unknown', confidence: 0.92, risk: 'red' },
  ...Array(2).fill({ type: 'bird', count: 0, direction: 'unknown', confidence: 0, risk: 'green' })
];

for (const s of script) {
  const e = makeEvent({ cameraId: 'runway-east', ...s, snapshot: s.risk !== 'green' ? SNAP : undefined });
  try {
    const res = await fetch(`${SERVER}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
    const body = await res.json();
    console.log(`${e.risk.padEnd(6)} ${e.type} x${e.object_count}  ->  ${res.status}${body.incident ? '  incident: ' + body.incident.report.slice(0, 70) + '…' : ''}`);
  } catch (err) {
    console.error(`Could not reach ${SERVER}. Start the server first with: npm start`); process.exit(1);
  }
  await sleep(2000);
}
