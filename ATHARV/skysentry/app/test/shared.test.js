import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, DroneGate, alertSentence } from '../shared/risk.js';
import { BirdTracker } from '../shared/tracker.js';
import { makeEvent, validateEvent } from '../shared/event.js';

test('risk rules match the build plan', () => {
  assert.equal(classifyRisk({ birdCount: 0 }).risk, 'green');
  assert.equal(classifyRisk({ birdCount: 3 }).risk, 'yellow');
  assert.equal(classifyRisk({ birdCount: 4 }).risk, 'yellow');
  assert.equal(classifyRisk({ birdCount: 5 }).risk, 'red');
  assert.equal(classifyRisk({ birdCount: 1, anyTowardRunway: true }).risk, 'red');
  assert.equal(classifyRisk({ birdCount: 0, droneHeard: true }).risk, 'red');
});

test('drone must stay above 0.8 for one second', () => {
  const g = new DroneGate();
  assert.equal(g.update(0.9, 0), false);
  assert.equal(g.update(0.9, 600), false);
  assert.equal(g.update(0.9, 1000), true);
  assert.equal(g.update(0.5, 1100), false);
  assert.equal(g.update(0.95, 1200), false);
});

test('alert sentence', () => {
  assert.equal(alertSentence({ type: 'bird', object_count: 8, direction: 'toward runway' }), 'Caution, flock of eight birds heading toward the runway.');
  assert.equal(alertSentence({ type: 'drone', object_count: 1 }), 'Caution, drone detected near the runway.');
});

const box = (x, y) => ({ x, y, width: 20, height: 14, score: 0.9 });

test('tracker keeps ids and reads leftward motion as toward the runway', () => {
  const tr = new BirdTracker({ smoothing: 0 });
  let r = tr.update([box(500, 100), box(560, 140)], 640);
  assert.equal(r.count, 2);
  const ids = r.tracks.map(t => t.id).sort();
  r = tr.update([box(480, 101), box(540, 141)], 640);
  assert.deepEqual(r.tracks.map(t => t.id).sort(), ids);
  assert.equal(r.anyTowardRunway, true);
  assert.equal(r.direction, 'toward runway');
});

test('tracker reads rightward motion as away and vertical motion as crossing', () => {
  const tr = new BirdTracker({ smoothing: 0 });
  tr.update([box(100, 100)], 640);
  assert.equal(tr.update([box(120, 101)], 640).tracks[0].heading, 'away from runway');
  const tv = new BirdTracker({ smoothing: 0 });
  tv.update([box(300, 100)], 640);
  assert.equal(tv.update([box(301, 125)], 640).tracks[0].heading, 'crossing');
});

test('tracker drops tracks after they go missing', () => {
  const tr = new BirdTracker({ maxMissed: 2 });
  tr.update([box(300, 100)], 640);
  for (let i = 0; i < 3; i++) tr.update([], 640);
  assert.equal(tr.tracks.length, 0);
});

test('events validate, and green events never carry snapshots', () => {
  const e = makeEvent({ cameraId: 'runway-east', type: 'bird', count: 6, direction: 'toward runway', confidence: 0.823, risk: 'red', snapshot: 'abc' });
  assert.deepEqual(validateEvent(e), []);
  assert.equal(e.confidence, 0.82);
  const g = makeEvent({ cameraId: 'runway-east', type: 'bird', count: 0, direction: 'unknown', confidence: 0, risk: 'green', snapshot: 'abc' });
  assert.equal(g.snapshot, undefined);
  assert.ok(validateEvent({ ...e, risk: 'purple' }).length > 0);
  assert.ok(validateEvent({ ...e, object_count: -1 }).length > 0);
});
