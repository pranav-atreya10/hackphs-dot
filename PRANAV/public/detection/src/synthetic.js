// Synthetic sky: renders test scenes straight into RGBA pixel buffers (no canvas needed),
// so the whole pipeline can be tested and tuned without clips or real birds.
// Birds flap (their silhouette pulses), drones hold a steady size, bags tumble randomly,
// clouds drift, and every frame gets sensor noise.

export const SCENARIOS = {
  flock_corridor: {
    expectFlock: 6, expectHz: 4, expectClass: 'bird',
    describe: 'Flock of 6 geese in a V, flapping ~4 Hz, flying right into the corridor',
    durationSec: 12,
    expected: 'red',
    corridor: [[0.72, 0], [1, 0], [1, 1], [0.72, 1]],
    build(add, rng) {
      const offsets = [[0, 0], [-13, -8], [-13, 8], [-26, -16], [-26, 16], [-39, -24]];
      offsets.forEach(([dx, dy], i) => add(bird(30 + dx, 110 + dy, 21, -1, 4 + rng() * 0.6 - 0.3, rng() * 6.28, 5.5)));
    },
  },
  single_bird: {
    expectFlock: 0, expectHz: 3.3, expectClass: 'bird',
    describe: 'One gull flapping ~3.3 Hz crossing right to left, away from the corridor',
    durationSec: 10,
    expected: 'yellow',
    corridor: [[0.72, 0], [1, 0], [1, 1], [0.72, 1]],
    build(add) { add(bird(205, 80, -16, 2, 3.3, 0, 7)); },
  },
  drone: {
    expectClass: 'drone', forbidClass: 'bird',
    describe: 'Quadcopter holding a steady size while drifting, with drone sound',
    durationSec: 10,
    expected: 'red',
    audioDrone: true,
    corridor: [],
    build(add) { add(drone(80, 70)); },
  },
  drone_silent: {
    forbidClass: 'bird',
    describe: 'Same steady object but no drone sound: should stay unknown',
    durationSec: 10,
    expected: 'yellow',
    corridor: [],
    build(add) { add(drone(80, 70)); },
  },
  bag: {
    forbidClass: 'bird',
    describe: 'Plastic bag tumbling and drifting in the wind (irregular size changes)',
    durationSec: 10,
    expected: 'yellow',
    corridor: [],
    build(add, rng) { add(bag(60, 120, rng)); },
  },
  plane: {
    forbidClass: 'bird',
    describe: 'Distant plane crossing fast with a steady silhouette',
    durationSec: 8,
    expected: 'yellow',
    corridor: [],
    build(add) { add(plane(-20, 50)); },
  },
  empty: {
    expectFlock: 0,
    describe: 'Clouds drifting and sensor noise only: must stay green',
    durationSec: 12,
    expected: 'green',
    corridor: [[0.72, 0], [1, 0], [1, 1], [0.72, 1]],
    build() {},
  },
  distant_flock: {
    expectFlock: 8, expectClass: 'bird',
    describe: '8 small, far-away birds (few pixels each) in loose formation',
    durationSec: 12,
    expected: 'red',
    corridor: [],
    build(add, rng) {
      for (let i = 0; i < 8; i++) add(bird(40 + (i % 4) * 11 + rng() * 3, 60 + Math.floor(i / 4) * 10 + rng() * 3, 14, 0.5, 5 + rng(), rng() * 6.28, 3));
    },
  },
  // Debris scenes: a tumbling rock's outline pulses as it turns, which looks like a wingbeat.
  // Unverified objects may raise yellow, but none of these may ever be called a bird or reach red.
  rock_throw: {
    forbidClass: 'bird', expectClass: 'debris',
    describe: 'A rock thrown up across the sky: tumbles (outline pulses ~4 Hz) along a gravity arc',
    durationSec: 4,
    expected: 'yellow',
    corridor: [[0.72, 0], [1, 0], [1, 1], [0.72, 1]],
    // ~8 px long (a 12 cm rock seen from ~10 m), so gravity is ~420 px/s² at this scale.
    build(add, rng) { add(rock(40, 236, 75, -400, 420, 2 + rng() * 0.3, 4, rng() * 6.28)); },
  },
  debris_shower: {
    forbidClass: 'bird', expectClass: 'debris',
    describe: 'Five pieces of gravel thrown together (would otherwise look like a flock of 5)',
    durationSec: 4,
    expected: 'yellow',
    corridor: [[0.72, 0], [1, 0], [1, 1], [0.72, 1]],
    build(add, rng) {
      for (let i = 0; i < 5; i++) add(rock(30 + i * 9 + rng() * 4, 236 - rng() * 6, 55 + rng() * 25, -380 - rng() * 30, 420, 1.6 + rng() * 1.4, 2.5 + rng() * 1.3, rng() * 6.28));
    },
  },
  spinning_debris: {
    forbidClass: 'bird',
    describe: 'A strip of debris blown sideways, spinning steadily (regular outline pulse, but the shape rotates)',
    durationSec: 8,
    expected: 'yellow',
    corridor: [],
    build(add, rng) { add(spinner(30, 90, 22, 3, 2.1 + rng() * 0.3, 0.9, 8)); },
  },
  // Guards: real birds whose paths curve or sink must stay birds.
  bird_descending: {
    expectClass: 'bird', expectHz: 3.5,
    describe: 'A gull flapping ~3.5 Hz while gliding steadily downward',
    durationSec: 10,
    expected: 'yellow',
    corridor: [],
    build(add) { add(bird(30, 40, 18, 9, 3.5, 0, 7)); },
  },
  bird_circling: {
    expectClass: 'bird', expectHz: 3,
    describe: 'A gull flapping ~3 Hz while circling (its path curves the whole time)',
    durationSec: 12,
    expected: 'yellow',
    corridor: [],
    build(add) { add(circler(150, 110, 40, 7, 3, 7)); },
  },
};

// ---------- object models (positions in px at 320x240; scaled to the output size) ----------

function bird(x0, y0, vx, vy, hz, phase, span) {
  return {
    type: 'bird',
    at(t) {
      const ph = 2 * Math.PI * hz * t + phase;
      const open = 0.5 + 0.5 * Math.cos(ph);             // 1 = wings spread, 0 = folded
      return {
        x: x0 + vx * t,
        y: y0 + vy * t + 0.6 * Math.sin(ph),             // body bobs with each beat
        rx: span * (0.45 + 0.55 * open),
        ry: span * 0.22 * (1 + 0.8 * Math.abs(Math.sin(ph))),
        dark: 0.55,
      };
    },
  };
}

function drone(x0, y0) {
  return {
    type: 'drone',
    at(t) {
      return { x: x0 + 9 * t + 6 * Math.sin(t * 0.7), y: y0 + 4 * Math.sin(t * 0.5), rx: 4.2, ry: 2.6, dark: 0.6 };
    },
  };
}

function plane(x0, y0) {
  return { type: 'plane', at(t) { return { x: x0 + 42 * t, y: y0 + 2 * t, rx: 13, ry: 2.6, dark: 0.5 }; } };
}

// Thrown rock: constant sideways speed, gravity pulling down at g px/s², tumbling end over end.
// Tumbling makes the outline pulse twice per turn, so its "beat" looks like a wingbeat.
// len is the half-length in px; keep g physical for that size (g ≈ 9.8 m/s² × px per metre).
function rock(x0, y0, vx, vy0, g, tumbleHz, len, phase) {
  return {
    type: 'rock',
    at(t) {
      const ph = Math.PI * tumbleHz * t + phase;
      return {
        x: x0 + vx * t,
        y: y0 + vy0 * t + 0.5 * g * t * t,
        rx: len * (0.45 + 0.55 * Math.abs(Math.cos(ph))),
        ry: len * 0.45,
        angle: phase + 2 * Math.PI * 0.6 * tumbleHz * t, // the shape also turns in the image plane
        dark: 0.6,
      };
    },
  };
}

// Wind-blown strip of debris: drifts at a steady speed but keeps rotating.
function spinner(x0, y0, vx, vy, pulseHz, spinHz, len) {
  return {
    type: 'debris',
    at(t) {
      return {
        x: x0 + vx * t,
        y: y0 + vy * t,
        rx: len * (0.5 + 0.5 * Math.abs(Math.cos(Math.PI * pulseHz * t))),
        ry: len * 0.3,
        angle: 2 * Math.PI * spinHz * t,
        dark: 0.5,
      };
    },
  };
}

// Bird circling at radius r px, one lap every periodSec, flapping at hz.
function circler(cx, cy, r, periodSec, hz, span) {
  const b = bird(0, 0, 0, 0, hz, 0, span);
  return {
    type: 'bird',
    at(t) {
      const s = b.at(t);
      const a = (2 * Math.PI * t) / periodSec;
      return { ...s, x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) + s.y };
    },
  };
}

function bag(x0, y0, rng) {
  // Smooth random noise with UNEVEN knot spacing (0.07-0.3 s, like gusty wind).
  // Evenly spaced knots accidentally create a rhythm at 1/(2 x spacing).
  const knotT = [0];
  for (let i = 1; i < 400; i++) knotT.push(knotT[i - 1] + 0.07 + rng() * 0.23);
  const knots = knotT.map(() => [rng(), rng(), rng()]);
  const noise = (t, c) => {
    let lo = 0, hi = knotT.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (knotT[mid] <= t) lo = mid; else hi = mid; }
    const f = Math.min(1, Math.max(0, (t - knotT[lo]) / (knotT[hi] - knotT[lo])));
    const s = f * f * (3 - 2 * f);
    return knots[lo][c] + (knots[hi][c] - knots[lo][c]) * s;
  };
  return {
    type: 'bag',
    at(t) {
      return {
        x: x0 + 13 * t + 6 * (noise(t * 0.4, 2) - 0.5),
        y: y0 - 3 * t + 8 * (noise(t * 0.3, 0) - 0.5),
        rx: 2.5 + 5 * noise(t, 0),
        ry: 2 + 4 * noise(t, 1),
        dark: 0.25 + 0.2 * noise(t, 2),
        bright: true,
      };
    },
  };
}

// ---------- renderer ----------

export class SyntheticSky {
  constructor({ width = 320, height = 240, scenario = 'flock_corridor', seed = 1, noise = 3, clouds = true } = {}) {
    this.width = width;
    this.height = height;
    this.scale = width / 320;
    this.scenarioName = scenario;
    this.scenario = SCENARIOS[scenario];
    if (!this.scenario) throw new Error(`Unknown scenario ${scenario}`);
    this.noise = noise;
    this.rng = mulberry32(seed);
    this.objects = [];
    this.scenario.build((o) => this.objects.push(o), this.rng);
    this.data = new Uint8ClampedArray(width * height * 4);

    // Sky gradient, precomputed.
    this.base = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      const f = y / (height - 1);
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        this.base[i] = 118 + 70 * f;
        this.base[i + 1] = 168 + 45 * f;
        this.base[i + 2] = 228 + 12 * f;
      }
    }
    this.clouds = clouds
      ? Array.from({ length: 3 }, () => ({ x: this.rng() * width, y: this.rng() * height * 0.8, r: (40 + this.rng() * 40) * this.scale, vx: (2 + this.rng() * 3) * this.scale, amp: 18 + this.rng() * 12 }))
      : [];
  }

  get expected() { return this.scenario.expected; }
  get corridor() { return this.scenario.corridor; }
  get durationSec() { return this.scenario.durationSec; }
  audioProbability() { return this.scenario.audioDrone ? 0.95 : 0.05; }

  render(t) {
    const { width: w, height: h, data, base } = this;
    const rng = this.rng;
    const nz = this.noise;
    for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 4, k += 3) {
      const n = (rng() * 2 - 1) * nz;
      data[j] = base[k] + n;
      data[j + 1] = base[k + 1] + n;
      data[j + 2] = base[k + 2] + n;
      data[j + 3] = 255;
    }
    for (const c of this.clouds) this.drawCloud(c.x + c.vx * t, c.y, c.r, c.amp);
    for (const o of this.objects) {
      const s = o.at(t);
      this.drawEllipse(s.x * this.scale, s.y * this.scale, s.rx * this.scale, s.ry * this.scale, s.dark, s.bright, s.angle || 0);
    }
    return { data, width: w, height: h };
  }

  drawCloud(cx, cy, r, amp) {
    const { width: w, height: h, data } = this;
    cx = ((cx % (w + 2 * r)) + w + 2 * r) % (w + 2 * r) - r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
        if (d2 >= 1) continue;
        const add = amp * (1 - d2) * (1 - d2);
        const j = (y * w + x) * 4;
        data[j] += add; data[j + 1] += add; data[j + 2] += add * 0.6;
      }
    }
  }

  // Anti-aliased filled ellipse, rotated by `angle` radians; darkens (or brightens) the sky under it.
  drawEllipse(cx, cy, rx, ry, dark, bright, angle = 0) {
    const { width: w, height: h, data } = this;
    const c = Math.cos(angle), s = Math.sin(angle);
    const ex = Math.hypot(rx * c, ry * s), ey = Math.hypot(rx * s, ry * c); // half-extents of the rotated box
    const x0 = Math.max(0, Math.floor(cx - ex - 1)), x1 = Math.min(w - 1, Math.ceil(cx + ex + 1));
    const y0 = Math.max(0, Math.floor(cy - ey - 1)), y1 = Math.min(h - 1, Math.ceil(cy + ey + 1));
    const rmin = Math.min(rx, ry);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - cx, py = y + 0.5 - cy;
        const dx = (px * c + py * s) / rx, dy = (py * c - px * s) / ry;
        const edge = (Math.sqrt(dx * dx + dy * dy) - 1) * rmin;
        const cov = Math.max(0, Math.min(1, 0.5 - edge));
        if (!cov) continue;
        const j = (y * w + x) * 4;
        const k = bright ? 1 + cov * dark * 0.5 : 1 - cov * dark;
        data[j] *= k; data[j + 1] *= k; data[j + 2] *= k;
      }
    }
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
