// Bird tracking from the build plan (prompt D2): match each bird box to the nearest box
// in the next frame, which gives a count, a direction arrow, and whether birds are
// heading toward the runway side. The left part of the frame is the runway side.

/** @typedef {{x:number, y:number, width:number, height:number, score:number}} Box  pixel box, x/y = top-left */

export class BirdTracker {
  /**
   * @param {Object} [o]
   * @param {number} [o.maxJump=0.12]        largest move between frames, as a fraction of frame width
   * @param {number} [o.runwaySide=0.5]      fraction of frame width from the left that counts as runway side
   * @param {number} [o.minSpeed=0.004]      below this per-frame move (fraction of width) a bird counts as stationary
   * @param {number} [o.maxMissed=5]         frames a track survives without a match
   * @param {number} [o.smoothing=0.6]       velocity smoothing, 0 = none
   */
  constructor(o = {}) {
    this.maxJump = o.maxJump ?? 0.12;
    this.runwaySide = o.runwaySide ?? 0.5;
    this.minSpeed = o.minSpeed ?? 0.004;
    this.maxMissed = o.maxMissed ?? 5;
    this.smoothing = o.smoothing ?? 0.6;
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * @param {Box[]} boxes   bird detections for this frame
   * @param {number} frameWidth
   * @returns {{tracks:Array, count:number, anyTowardRunway:boolean, direction:string}}
   */
  update(boxes, frameWidth) {
    const centers = boxes.map(b => ({ box: b, cx: (b.x + b.width / 2) / frameWidth, cy: (b.y + b.height / 2) / frameWidth }));
    const unmatched = new Set(centers.keys());

    // Greedy nearest-neighbour matching, closest pairs first.
    const pairs = [];
    this.tracks.forEach((t, ti) => centers.forEach((c, ci) => {
      const d = Math.hypot(c.cx - t.cx, c.cy - t.cy);
      if (d <= this.maxJump) pairs.push({ ti, ci, d });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const usedTracks = new Set();
    for (const { ti, ci } of pairs) {
      if (usedTracks.has(ti) || !unmatched.has(ci)) continue;
      const t = this.tracks[ti], c = centers[ci];
      const vx = c.cx - t.cx, vy = c.cy - t.cy, k = this.smoothing;
      t.vx = t.vx * k + vx * (1 - k); t.vy = t.vy * k + vy * (1 - k);
      t.cx = c.cx; t.cy = c.cy; t.box = c.box; t.missed = 0; t.age++;
      usedTracks.add(ti); unmatched.delete(ci);
    }
    this.tracks.forEach((t, ti) => { if (!usedTracks.has(ti)) t.missed++; });
    this.tracks = this.tracks.filter(t => t.missed <= this.maxMissed);
    for (const ci of unmatched) {
      const c = centers[ci];
      this.tracks.push({ id: this.nextId++, cx: c.cx, cy: c.cy, vx: 0, vy: 0, box: c.box, missed: 0, age: 1 });
    }

    const visible = this.tracks.filter(t => t.missed === 0);
    visible.forEach(t => { t.heading = this.headingOf(t); });
    const anyTowardRunway = visible.some(t => t.heading === 'toward runway');
    return { tracks: visible, count: visible.length, anyTowardRunway, direction: this.summarize(visible) };
  }

  headingOf(t) {
    if (t.age < 2) return 'unknown';
    if (Math.hypot(t.vx, t.vy) < this.minSpeed) return 'stationary';
    // The runway is on the left. Mostly-sideways motion decides toward/away; mostly-vertical motion is crossing.
    const sideways = Math.abs(t.vx) >= Math.abs(t.vy) * 0.5;
    if (sideways) return t.vx < 0 ? 'toward runway' : 'away from runway';
    return 'crossing';
  }

  summarize(tracks) {
    if (!tracks.length) return 'unknown';
    if (tracks.some(t => t.heading === 'toward runway')) return 'toward runway';
    const counts = {};
    tracks.forEach(t => { counts[t.heading] = (counts[t.heading] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  reset() { this.tracks = []; }
}
