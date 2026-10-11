// Tower beacon (software only): turns detector state or server events into a compact beacon frame
// and shows it on screen (VirtualBeacon). No hardware, USB or serial port is involved.
//
// Frame line, one per update:
//
//   B <seq> <level> <kind> <count> <eta_s> <aim_deg> <flap_dHz>
//     level  G | Y | R              risk level
//     kind   N | B | D | U          none / bird / drone / unknown (the primary threat)
//     count  0-99                   flock size / object count
//     eta_s  whole seconds, -1      time to the approach corridor, -1 = not heading in
//     aim    0-180, -1              where the on-screen arrow points, -1 = straight up
//     flap   Hz x 10, -1            wingbeat rate (3.8 Hz -> 38)
//
// Example: "B 42 R B 6 9 63 38" = red, flock of 6 birds, 9 s out, arrow at 63 deg, 3.8 Hz.

export const BEACON_DEFAULTS = {
  minIntervalMs: 200,   // at most 5 updates/s (keeps the arrow steady)
  heartbeatMs: 1000,    // re-render even if nothing changed (feeds the 3 s 'no data' watchdog)
  servoScale: 2,        // 1 = true compass pointing; 2 = exaggerate the arrow swing
  servoInvert: false,   // flip if the arrow turns the wrong way
  servoDeadband: 2,     // ignore aim changes smaller than this (stops arrow jitter)
};

const LEVEL = { green: 'G', yellow: 'Y', red: 'R' };
const KIND = { bird: 'B', drone: 'D', unknown: 'U' };

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Normalized beacon frame from plain values.
// input: { level, classification, size, eta_seconds, bearing_deg }, cameraHeading in degrees.
export function beaconFrame(input, cameraHeading, opts = BEACON_DEFAULTS) {
  const level = LEVEL[input.level] || 'G';
  const hasTarget = level !== 'G' && input.classification && input.classification !== 'rejected' && input.classification !== 'debris';
  const kind = hasTarget ? KIND[input.classification] || 'U' : 'N';
  let servo = -1;
  if (hasTarget && input.bearing_deg !== null && input.bearing_deg !== undefined && cameraHeading !== undefined) {
    // 90 = straight ahead (camera heading). Positive relative bearing = target to the right.
    const rel = wrap180(input.bearing_deg - cameraHeading);
    const sign = opts.servoInvert ? 1 : -1;
    servo = Math.round(clamp(90 + sign * rel * opts.servoScale, 0, 180));
  }
  return {
    level,
    kind,
    count: hasTarget ? clamp(Math.round(input.size || 0), 0, 99) : 0,
    eta: hasTarget && input.eta_seconds !== null && input.eta_seconds !== undefined ? clamp(Math.round(input.eta_seconds), 0, 999) : -1,
    servo,
    flap: hasTarget && input.flap_hz ? clamp(Math.round(input.flap_hz * 10), 0, 999) : -1,
  };
}

// From the engine's per-frame state (camera station side).
export function frameFromState(state, camera, opts) {
  const p = state.primary;
  return beaconFrame({
    level: state.risk.level,
    classification: p ? p.classification : null,
    size: p ? p.size : 0,
    eta_seconds: p ? p.eta_seconds : null,
    bearing_deg: p ? p.bearing_deg : null,
    flap_hz: p ? p.flap_hz : null,
  }, camera.heading_deg, opts);
}

// From a contract 'event' (tower side: the server forwards these over Socket.IO).
export function frameFromEvent(ev, opts) {
  return beaconFrame({
    level: ev.risk,
    classification: ev.classification,
    size: ev.flock_size || ev.object_count,
    eta_seconds: ev.eta_seconds,
    bearing_deg: ev.bearing_deg,
    flap_hz: ev.flap_hz,
  }, ev.camera ? ev.camera.heading_deg : undefined, opts);
}

export function encodeBeacon(seq, f) {
  return `B ${seq} ${f.level} ${f.kind} ${f.count} ${f.eta} ${f.servo} ${f.flap}`;
}

// Parser for beacon lines (used by the on-screen VirtualBeacon and the tests).
export function parseBeaconLine(line) {
  const m = /^B (\d+) ([GYR]) ([NBDU]) (\d+) (-?\d+) (-?\d+) (-?\d+)$/.exec(String(line).trim());
  if (!m) return null;
  return { seq: +m[1], level: m[2], kind: m[3], count: +m[4], eta: +m[5], servo: +m[6], flap: +m[7] };
}

function meaningfullyDifferent(a, b, deadband) {
  if (!a || !b) return true;
  if (a.level !== b.level || a.kind !== b.kind || a.count !== b.count || a.eta !== b.eta || a.flap !== b.flap) return true;
  if ((a.servo < 0) !== (b.servo < 0)) return true;
  return Math.abs(a.servo - b.servo) >= deadband;
}

// Software pacer: decides when the beacon should update (on a meaningful change, rate-limited, with
// instant escalation and a heartbeat) and hands each encoded line to writeLine (the on-screen beacon).
export class BeaconPacer {
  constructor(opts = {}) {
    this.opts = { ...BEACON_DEFAULTS, ...opts };
    this.seq = 0;
    this.want = null;      // latest frame the beacon should show
    this.sent = null;      // last frame actually rendered
    this.lastSendMs = -Infinity;
    this.stats = { sent: 0, lastLine: null };
    this.writeLine = async () => {};   // set by the page, e.g. line => virtualBeacon.feed(line)
    this.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  // Feed the engine directly (camera station).
  attachEngine(engine) {
    return engine.on('frame', (state) => this.push(frameFromState(state, engine.cfg.camera, this.opts)));
  }

  // Or feed server events (tower dashboard): socket.on('event', (ev) => beacon.pushEvent(ev)).
  pushEvent(ev) {
    this.push(frameFromEvent(ev, this.opts));
  }

  push(frame) {
    this.want = frame;
    this.tick();
  }

  tick() {
    if (!this.want) return null;
    const now = this.now();
    const since = now - this.lastSendMs;
    const changed = meaningfullyDifferent(this.want, this.sent, this.opts.servoDeadband);
    const escalated = this.sent && this.want.level !== this.sent.level && 'GYR'.indexOf(this.want.level) > 'GYR'.indexOf(this.sent.level);
    if ((changed && (since >= this.opts.minIntervalMs || escalated)) || since >= this.opts.heartbeatMs) {
      const seq = (this.seq = (this.seq + 1) % 100000);
      const line = encodeBeacon(seq, this.want);
      this.sent = this.want;
      this.lastSendMs = now;
      this.stats.sent++; this.stats.lastLine = line;
      Promise.resolve(this.writeLine(line)).catch(() => {});
      return line;
    }
    return null;
  }
}

// The beacon itself: three lamps, an arrow toward the threat and a short status line, drawn on screen.
export class VirtualBeacon {
  constructor(el) {
    this.el = el;
    this.state = null;
    this.lastMs = 0;
    el.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;font:600 14px system-ui">
        <span data-l="G" style="width:22px;height:22px;border-radius:50%;background:#1b5e20;opacity:.2"></span>
        <span data-l="Y" style="width:22px;height:22px;border-radius:50%;background:#f9a825;opacity:.2"></span>
        <span data-l="R" style="width:22px;height:22px;border-radius:50%;background:#c62828;opacity:.2"></span>
        <span data-arrow style="display:inline-block;font-size:22px;transition:transform .2s">&#8593;</span>
        <span data-text></span>
      </div>`;
    this.timer = setInterval(() => this.render(), 125);
  }

  feed(line) {
    const f = parseBeaconLine(line);
    if (f) { this.state = f; this.lastMs = performance.now(); }
    return f;
  }

  render() {
    const now = performance.now();
    const f = this.state;
    const online = f && now - this.lastMs < 3000;
    const lamps = { G: 0, Y: 0, R: 0 };
    let text = 'NO DATA';
    if (!online) {
      lamps['GYR'[Math.floor(now / 250) % 3]] = 1; // chase = no updates from the tower page
    } else {
      if (f.level === 'G') lamps.G = 1;
      if (f.level === 'Y') lamps.Y = Math.floor(now / 500) % 2;
      if (f.level === 'R') {
        const on = Math.floor(now / 125) % 2;
        if (f.kind === 'D') { lamps.R = on; lamps.Y = 1 - on; } else lamps.R = on;
      }
      const what = { N: 'CLEAR', B: f.count > 1 ? `FLOCK ${f.count}` : 'BIRD', D: 'DRONE', U: 'UNKNOWN' }[f.kind];
      text = `${what}${f.eta >= 0 ? `  ETA ${f.eta}s` : ''}${f.flap >= 0 ? `  ${(f.flap / 10).toFixed(1)}Hz` : ''}`;
    }
    for (const k of 'GYR') this.el.querySelector(`[data-l="${k}"]`).style.opacity = lamps[k] ? 1 : 0.15;
    const ang = online && f.servo >= 0 ? 90 - f.servo : 0; // 90 = straight up on screen
    this.el.querySelector('[data-arrow]').style.transform = `rotate(${ang}deg)`;
    this.el.querySelector('[data-text]').textContent = text;
  }

  destroy() { clearInterval(this.timer); }
}
