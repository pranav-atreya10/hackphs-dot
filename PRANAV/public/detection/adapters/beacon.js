// Tower beacon: drives an Arduino (LEDs, buzzer, pointing servo, optional LCD) from the
// detection engine over USB using Web Serial (Chrome/Edge desktop, https or localhost).
//
// Protocol, laptop -> Arduino, one ASCII line per update (max ~40 chars, fits the Uno's
// 64-byte serial buffer):
//
//   B <seq> <level> <kind> <count> <eta_s> <servo_deg> <flap_dHz>\n
//     level  G | Y | R              risk level
//     kind   N | B | D | U          none / bird / drone / unknown (the primary threat)
//     count  0-99                   flock size / object count
//     eta_s  whole seconds, -1      time to the approach corridor, -1 = not heading in
//     servo  0-180, -1              where the pointer should aim, -1 = park centred
//     flap   Hz x 10, -1            wingbeat rate (3.8 Hz -> 38)
//
// Arduino -> laptop:  "READY beacon v1" after boot, "OK <seq>" per line, "ERR ..." on a bad line.
//
// Example: "B 42 R B 6 9 63 38" = red, flock of 6 birds, 9 s out, point at 63 deg, 3.8 Hz.

export const BEACON_DEFAULTS = {
  baudRate: 115200,
  minIntervalMs: 200,   // at most 5 updates/s (servo can't use more, serial stays quiet)
  heartbeatMs: 1000,    // resend even if nothing changed: feeds the beacon's 3 s offline watchdog
  servoScale: 2,        // 1 = true compass pointing; 2 = exaggerate so a 65 deg view swings +-65 deg
  servoInvert: false,   // flip if the arrow turns the wrong way (depends on how the servo is mounted)
  servoDeadband: 2,     // ignore aim changes smaller than this (stops servo buzz/wear)
  readyTimeoutMs: 4000, // Uno resets when the port opens; wait this long for "READY"
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

// Mirror of the Arduino parser (used by the on-screen VirtualBeacon and the tests).
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

export class BeaconLink {
  constructor(opts = {}) {
    this.opts = { ...BEACON_DEFAULTS, ...opts };
    this.port = null;
    this.writer = null;
    this.seq = 0;
    this.want = null;      // latest frame we'd like the beacon to show
    this.sent = null;      // last frame actually sent
    this.lastSendMs = -Infinity;
    this.pendingAcks = new Map();
    this.listeners = new Set();
    this.timer = null;
    this.stats = { connected: false, ready: false, sent: 0, acked: 0, errors: 0, latencyMs: null, lastLine: null, lastError: null, device: null };
    // Overridable for tests / other transports (WebSocket bridge, Raspberry Pi, ...).
    this.writeLine = async (line) => { if (this.writer) await this.writer.write(line + '\n'); };
    this.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // Must be called from a click handler (the browser shows a port picker).
  async connect(port) {
    if (!BeaconLink.supported()) throw new Error('Web Serial not available: use desktop Chrome or Edge on https/localhost');
    this.port = port || (await navigator.serial.requestPort());
    await this.port.open({ baudRate: this.opts.baudRate });
    this.stats.connected = true;
    const enc = new TextEncoderStream();
    enc.readable.pipeTo(this.port.writable).catch((e) => this.fail(e));
    this.writer = enc.writable.getWriter();
    this.readLoop();
    // The Uno reboots when the port opens; wait for the sketch to say READY.
    const ready = await new Promise((resolve) => {
      const done = (ok) => { clearTimeout(to); this.listeners.delete(onLine); resolve(ok); };
      const onLine = (l) => { if (l.startsWith('READY')) { this.stats.device = l; done(true); } };
      const to = setTimeout(() => done(false), this.opts.readyTimeoutMs);
      this.listeners.add(onLine);
    });
    this.stats.ready = ready;
    if (!ready) console.warn('[beacon] no READY from the board; sending anyway');
    this.timer = setInterval(() => this.tick(), Math.min(this.opts.minIntervalMs, this.opts.heartbeatMs) / 2);
    return this.stats;
  }

  async readLoop() {
    const dec = new TextDecoderStream();
    this.port.readable.pipeTo(dec.writable).catch((e) => this.fail(e));
    const reader = dec.readable.getReader();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.onLine(line);
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  onLine(line) {
    this.stats.lastLine = line;
    const ok = /^OK (\d+)/.exec(line);
    if (ok) {
      const sentAt = this.pendingAcks.get(+ok[1]);
      if (sentAt !== undefined) {
        this.pendingAcks.delete(+ok[1]);
        const ms = this.now() - sentAt;
        this.stats.latencyMs = this.stats.latencyMs === null ? ms : Math.round(this.stats.latencyMs * 0.8 + ms * 0.2);
      }
      this.stats.acked++;
    } else if (line.startsWith('ERR')) {
      this.stats.errors++;
    }
    for (const fn of this.listeners) fn(line);
  }

  fail(e) {
    this.stats.lastError = e.message || String(e);
    this.stats.connected = false;
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

  // Decide whether to send now: on a meaningful change (rate-limited) or as a heartbeat.
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
      this.pendingAcks.set(seq, now);
      if (this.pendingAcks.size > 50) this.pendingAcks.delete(this.pendingAcks.keys().next().value);
      this.stats.sent++;
      this.writeLine(line).catch((e) => this.fail(e));
      return line;
    }
    return null;
  }

  async disconnect() {
    clearInterval(this.timer);
    try { if (this.writer) { await this.writer.close(); } } catch (e) { /* port already gone */ }
    try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }
    this.stats.connected = false;
  }
}

// On-screen copy of the beacon: same protocol, same patterns. Use it to rehearse without
// hardware, or as the backup if the Arduino fails mid-demo.
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
    let text = 'OFFLINE';
    if (!online) {
      lamps['GYR'[Math.floor(now / 250) % 3]] = 1; // chase = link lost
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
    const ang = online && f.servo >= 0 ? 90 - f.servo : 0; // servo 90 = straight up on screen
    this.el.querySelector('[data-arrow]').style.transform = `rotate(${ang}deg)`;
    this.el.querySelector('[data-text]').textContent = text;
  }

  destroy() { clearInterval(this.timer); }
}
