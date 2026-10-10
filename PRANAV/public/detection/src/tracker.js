// Smoothed velocity: least-squares line through the last `velWindowSec` of the trail.
// The alpha-beta velocity (tr.vx) reacts fast and is used to predict where to look next;
// this one (tr.svx) is calm and is used for ETA, heading and flock grouping.
// seX/seY are standard errors of the slopes, used to give the ETA a range.
function fitVelocity(tr, t, c) {
  const pts = tr.trail;
  let i0 = pts.length - 1;
  while (i0 > 0 && t - pts[i0 - 1][0] <= c.velWindowSec) i0--;
  const n = pts.length - i0;
  if (n < c.velMinPoints) {
    tr.svx = tr.vx; tr.svy = tr.vy; tr.seX = Infinity; tr.seY = Infinity;
    return;
  }
  let mt = 0, mx = 0, my = 0;
  for (let i = i0; i < pts.length; i++) { mt += pts[i][0]; mx += pts[i][1]; my += pts[i][2]; }
  mt /= n; mx /= n; my /= n;
  let stt = 0, stx = 0, sty = 0;
  for (let i = i0; i < pts.length; i++) {
    const dt = pts[i][0] - mt;
    stt += dt * dt; stx += dt * (pts[i][1] - mx); sty += dt * (pts[i][2] - my);
  }
  if (stt <= 0) return;
  tr.svx = stx / stt;
  tr.svy = sty / stt;
  let rx = 0, ry = 0;
  for (let i = i0; i < pts.length; i++) {
    const dt = pts[i][0] - mt;
    rx += (pts[i][1] - mx - tr.svx * dt) ** 2;
    ry += (pts[i][2] - my - tr.svy * dt) ** 2;
  }
  tr.seX = Math.sqrt(rx / (n - 2) / stt);
  tr.seY = Math.sqrt(ry / (n - 2) / stt);
}

// Multi-object tracker: keeps the same ID on the same bird from frame to frame.
//
// Each track predicts where it should be now from its velocity (alpha-beta filter),
// then blobs are matched to tracks closest-first inside a distance gate. A track
// is confirmed after a few consecutive hits and some real movement, so flickering
// noise never gets confirmed. Confirmed tracks survive a few missed frames.

export class Tracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = [];
    this.nextId = 1;
  }

  reset() {
    this.tracks = [];
  }

  update(blobs, t) {
    const c = this.cfg;
    const tracks = this.tracks;

    // 1. Candidate pairs within each track's gate.
    const pairs = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      const dt = t - tr.t;
      const px = tr.x + tr.vx * dt;
      const py = tr.y + tr.vy * dt;
      tr.px = px;
      tr.py = py;
      // A brand-new track has no velocity yet, so it gets the full jump distance. After
      // that the blob must land near the *predicted* spot, which random noise rarely does.
      const speed = Math.hypot(tr.vx, tr.vy);
      const base = tr.hits <= 1 ? c.maxJump : c.maxJump * c.predictedGate;
      const gate = base * (1 + 0.5 * tr.misses) + 0.25 * speed * dt;
      for (let bi = 0; bi < blobs.length; bi++) {
        const b = blobs[bi];
        const d = Math.hypot(b.x - px, b.y - py);
        if (d < gate) pairs.push(d, ti, bi);
      }
    }

    // 2. Greedy closest-first assignment.
    const order = [];
    for (let i = 0; i < pairs.length; i += 3) order.push(i);
    order.sort((a, b) => pairs[a] - pairs[b]);
    const trackUsed = new Uint8Array(tracks.length);
    const blobUsed = new Uint8Array(blobs.length);
    for (const i of order) {
      const ti = pairs[i + 1];
      const bi = pairs[i + 2];
      if (trackUsed[ti] || blobUsed[bi]) continue;
      trackUsed[ti] = 1;
      blobUsed[bi] = 1;
      this.hit(tracks[ti], blobs[bi], t);
    }

    // 3. Misses and deletion.
    const kept = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const tr = tracks[ti];
      if (!trackUsed[ti]) {
        tr.misses++;
        tr.totalMisses++;
        tr.consec = 0;
        const limit = tr.confirmed ? c.maxMisses : c.maxMissesTentative;
        if (tr.misses > limit) continue;
      }
      kept.push(tr);
    }

    // 4. New tentative tracks for unmatched blobs.
    for (let bi = 0; bi < blobs.length; bi++) {
      if (!blobUsed[bi]) kept.push(this.spawn(blobs[bi], t));
    }

    this.tracks = kept;
    return kept;
  }

  spawn(b, t) {
    const tr = {
      id: this.nextId++,
      x: b.x, y: b.y, vx: 0, vy: 0, px: b.x, py: b.y,
      t, born: t,
      ox: b.x, oy: b.y, travel: 0,
      hits: 1, consec: 1, misses: 0, totalMisses: 0,
      confirmed: false,
      blob: b,
      trail: [[t, b.x, b.y]],
      svx: 0, svy: 0, seX: Infinity, seY: Infinity, // smoothed (line-fit) velocity + its uncertainty
      samples: { t: [t], mass: [b.mass], area: [b.area], major: [b.major] },
      frameCount: 0,
    };
    return tr;
  }

  hit(tr, b, t) {
    const c = this.cfg;
    const dt = Math.max(1e-3, t - tr.t);
    if (tr.hits === 1) {
      tr.vx = (b.x - tr.x) / dt;
      tr.vy = (b.y - tr.y) / dt;
      tr.x = b.x;
      tr.y = b.y;
    } else {
      const rx = b.x - tr.px;
      const ry = b.y - tr.py;
      tr.x = tr.px + c.posGain * rx;
      tr.y = tr.py + c.posGain * ry;
      tr.vx += (c.velGain * rx) / dt;
      tr.vy += (c.velGain * ry) / dt;
    }
    tr.t = t;
    tr.hits++;
    tr.consec++;
    tr.misses = 0;
    tr.blob = b;
    tr.travel = Math.max(tr.travel, Math.hypot(b.x - tr.ox, b.y - tr.oy));
    if (!tr.confirmed && tr.consec >= c.confirmFrames && tr.travel >= c.minTravel) tr.confirmed = true;

    tr.trail.push([t, tr.x, tr.y]);
    while (tr.trail.length > 2 && t - tr.trail[0][0] > c.trailSec) tr.trail.shift();
    fitVelocity(tr, t, c);

    const s = tr.samples;
    s.t.push(t); s.mass.push(b.mass); s.area.push(b.area); s.major.push(b.major);
    let drop = 0;
    while (drop < s.t.length - 2 && t - s.t[drop] > c.sampleSec) drop++;
    if (drop) for (const k in s) s[k].splice(0, drop);
  }
}
