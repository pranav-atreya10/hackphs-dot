const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: flushAsync } = require('node:timers/promises');

let mountLandingLiveAi;
let LANDING_CLIPS;
let setupLandingLiveAiAutoMount;
let createV41WorkerClient;

before(async () => {
  ({
    mountLandingLiveAi,
    LANDING_CLIPS,
    setupLandingLiveAiAutoMount,
  } = await import('../public/js/landing-live-ai.mjs'));
  ({ createV41WorkerClient } = await import('../public/js/skysentry-v41-client.mjs'));
});

function activeCanvasOps(canvas) {
  const ops = canvas._ctx.ops;
  let startIdx = 0;
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    if (ops[i].op === 'clearRect' && ops[i].x === 0 && ops[i].y === 0) {
      startIdx = i + 1;
      break;
    }
  }
  return ops.slice(startIdx);
}
function toCamel(kebab) {
  return kebab.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

class FakeStyle {
  props = new Map();
  width = '';

  setProperty(name, value) {
    this.props.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.props.get(name) ?? '';
  }
}

class FakeClassList {
  set = new Set();

  add(...names) {
    for (const n of names) this.set.add(n);
  }

  remove(...names) {
    for (const n of names) this.set.delete(n);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  contains(name) {
    return this.set.has(name);
  }
}

function matchesSingleSelector(el, rawSel) {
  const sel = rawSel.trim();
  if (!sel) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (/^[a-z0-9]+$/i.test(sel)) return el.tagName === sel.toUpperCase();

  const attrMatch = sel.match(/^([a-z0-9]+)?\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
  if (attrMatch) {
    const [, tag, attrName, attrVal] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (!el.attributes.has(attrName)) return false;
    if (attrVal !== undefined) return el.attributes.get(attrName) === attrVal;
    return true;
  }
  return false;
}

function matchesSelectorList(el, selector) {
  return selector.split(',').some(part => matchesSingleSelector(el, part));
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.dataset = {};
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === 'id') this.id = str;
    if (name.startsWith('data-')) {
      this.dataset[toCamel(name.slice(5))] = str;
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      delete this.dataset[toCamel(name.slice(5))];
    }
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx >= 0) node.parentNode.children.splice(idx, 1);
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }

  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (!node) continue;
      node.parentNode = this;
      this.children.unshift(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, fn, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, once: Boolean(options?.once) });
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter(entry => entry.fn !== fn));
  }

  dispatchEvent(type, extra = {}) {
    const list = [...(this.listeners.get(type) || [])];
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() { this.defaultPrevented = true; },
      ...extra,
    };
    for (const entry of list) {
      if (entry.once) this.removeEventListener(type, entry.fn);
      entry.fn(event);
    }
    return event;
  }

  click() {
    return this.dispatchEvent('click');
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (matchesSelectorList(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function createFakeCanvas(width = 854, height = 480) {
  const el = new FakeElement('canvas');
  el.width = width;
  el.height = height;
  el.clientWidth = width;
  el.clientHeight = height;
  const ops = [];
  const ctx = {
    ops,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textBaseline: 'alphabetic',
    clearRect(x, y, w, h) { ops.push({ op: 'clearRect', x, y, w, h }); },
    drawImage(src, x, y, w, h) { ops.push({ op: 'drawImage', src, x, y, w, h }); },
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      if (data.length >= 4) {
        data[0] = 40;
        data[1] = 110;
        data[2] = 200;
        data[3] = 255;
      }
      return { width: w, height: h, data };
    },
    save() { ops.push({ op: 'save' }); },
    restore() { ops.push({ op: 'restore' }); },
    beginPath() { ops.push({ op: 'beginPath' }); },
    moveTo(x, y) { ops.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { ops.push({ op: 'lineTo', x, y }); },
    stroke() { ops.push({ op: 'stroke', strokeStyle: this.strokeStyle }); },
    arc(x, y, r, start, end) { ops.push({ op: 'arc', x, y, r, start, end, strokeStyle: this.strokeStyle }); },
    setLineDash(dash) { ops.push({ op: 'setLineDash', dash }); },
    strokeRect(x, y, w, h) { ops.push({ op: 'strokeRect', x, y, w, h }); },
    fillText(text, x, y) { ops.push({ op: 'fillText', text, x, y, fillStyle: this.fillStyle }); },
  };
  el.getContext = () => ctx;
  el._ctx = ctx;
  return el;
}

function createFakeVideo() {
  const video = new FakeElement('video');
  video.setAttribute('data-live-ai-video', '');
  video.videoWidth = 854;
  video.videoHeight = 480;
  video.readyState = 4;
  video.currentTime = 0;
  video.preload = 'auto';
  video.poster = '';
  video.muted = false;
  video.loop = false;
  video.playsInline = false;
  video.loads = 0;
  video.plays = 0;
  video.pauses = 0;
  video.paused = true;
  video.load = () => { video.loads += 1; };
  video.play = () => {
    video.plays += 1;
    video.paused = false;
    return Promise.resolve();
  };
  video.pause = () => {
    video.pauses += 1;
    video.paused = true;
  };
  return video;
}

function createFakeDocument({ readyState = 'complete' } = {}) {
  const doc = new FakeElement('document');
  doc.readyState = readyState;
  doc.hidden = false;
  doc.createElement = tag => {
    const lower = String(tag).toLowerCase();
    if (lower === 'canvas') return createFakeCanvas(0, 0);
    if (lower === 'video') return createFakeVideo();
    return new FakeElement(lower);
  };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  return doc;
}

function buildWidgetFixture(doc) {
  const root = new FakeElement('section');
  root.setAttribute('id', 'landingLiveAi');

  const playBtn = new FakeElement('button');
  playBtn.setAttribute('data-live-ai-play', '');
  playBtn.setAttribute('aria-pressed', 'false');
  playBtn.textContent = 'Run v4.1 in browser';

  const clipBtns = {};
  for (const clip of [
    ['starling-murmuration', 'Flock / Birds'],
    ['drone-hover', 'Hovering Quadcopter'],
    ['gulls-sky', 'Coastal Gulls'],
  ]) {
    const btn = new FakeElement('button');
    btn.setAttribute('data-clip', clip[0]);
    btn.textContent = clip[1];
    clipBtns[clip[0]] = btn;
    root.append(btn);
  }

  const stage = new FakeElement('div');
  stage.setAttribute('data-live-ai-stage', '');
  const video = createFakeVideo();
  const overlay = createFakeCanvas(854, 480);
  overlay.setAttribute('data-live-ai-overlay', '');
  stage.append(video, overlay);

  const fpsEl = new FakeElement('span');
  fpsEl.setAttribute('data-ai-fps', '');
  const msEl = new FakeElement('span');
  msEl.setAttribute('data-ai-ms', '');
  const tracksEl = new FakeElement('span');
  tracksEl.setAttribute('data-ai-tracks', '');
  const verdictEl = new FakeElement('span');
  verdictEl.setAttribute('data-ai-verdict', '');

  const probBars = {};
  const probPcts = {};
  for (const cls of ['bird', 'drone', 'other']) {
    const bar = new FakeElement('div');
    bar.setAttribute('data-prob', cls);
    const pct = new FakeElement('span');
    pct.setAttribute('data-prob-pct', cls);
    probBars[cls] = bar;
    probPcts[cls] = pct;
    root.append(bar, pct);
  }

  root.append(playBtn, stage, fpsEl, msEl, tracksEl, verdictEl);
  doc.append(root);

  return {
    root,
    playBtn,
    clipBtns,
    video,
    overlay,
    fpsEl,
    msEl,
    tracksEl,
    verdictEl,
    probBars,
    probPcts,
  };
}

class FakeWorker {
  messages = [];
  terminations = 0;
  autoReplyProbs = { bird: 0.9, drone: 0.06, other: 0.04 };
  manualClassify = false;
  manualLoad = false;

  postMessage(message, transfer) {
    this.messages.push(structuredClone(message, { transfer }));
    if (message.type === 'load' && !this.manualLoad) {
      queueMicrotask(() => {
        if (!this.terminations) this.onmessage?.({ data: { id: message.id, ok: true } });
      });
    } else if (message.type === 'classify' && !this.manualClassify) {
      const results = message.boxes.map(() => ({
        label: 'bird',
        score: this.autoReplyProbs.bird,
        probs: { ...this.autoReplyProbs },
        ms: 2.4,
      }));
      queueMicrotask(() => {
        if (!this.terminations) this.onmessage?.({ data: { id: message.id, ok: true, results } });
      });
    }
  }

  replyLatest(fields) {
    const latest = this.messages.at(-1);
    if (latest) this.onmessage?.({ data: { id: latest.id, ...fields } });
  }

  terminate() {
    this.terminations += 1;
  }
}

function createHarness(t, options = {}) {
  const doc = createFakeDocument();
  const ui = buildWidgetFixture(doc);

  let clockMs = 1000;
  let nextRafId = 1;
  const rafQueue = new Map();
  const engines = [];
  const workers = [];
  const scratchCanvases = [];
  const observers = [];

  let nextTracks = options.tracks ?? [
    {
      id: 1,
      classification: 'unknown',
      bbox: { x: 0.35, y: 0.28, w: 0.08, h: 0.06 },
      trail: [[0.33, 0.29], [0.35, 0.28]],
      missed: false,
      dense: false,
    },
  ];

  const controller = mountLandingLiveAi(ui.root, {
    document: doc,
    now: () => clockMs,
    getDevicePixelRatio: () => 1,
    requestFrame(cb) {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelFrame(id) {
      rafQueue.delete(id);
    },
    createScratchCanvas() {
      const c = createFakeCanvas(0, 0);
      scratchCanvases.push(c);
      return c;
    },
    createEngine(cfg) {
      const instance = {
        cfg,
        calls: [],
        resets: 0,
        process(imageData, mediaT) {
          clockMs += 1.5; // Simulate 1.5 ms motion + tracker CPU pass.
          this.calls.push({ width: imageData.width, height: imageData.height, t: mediaT });
          return {
            t: mediaT,
            motion: { ready: true, shake: false, overflow: false },
            tracks: typeof nextTracks === 'function' ? nextTracks(this.calls.length) : nextTracks,
            flocks: [],
          };
        },
        reset() {
          this.resets += 1;
        },
      };
      engines.push(instance);
      return instance;
    },
    createWorkerClient() {
      return createV41WorkerClient({
        createWorker() {
          const w = options.createWorker ? options.createWorker(workers.length) : new FakeWorker();
          workers.push(w);
          return w;
        },
        timeoutMs: 1000,
      });
    },
    createObserver(callback, observerOptions) {
      const obs = {
        callback,
        options: observerOptions,
        observed: [],
        disconnected: false,
        observe(target) { this.observed.push(target); },
        disconnect() { this.disconnected = true; },
        trigger(isIntersecting, intersectionRatio = isIntersecting ? 1 : 0) {
          callback([{ isIntersecting, intersectionRatio }]);
        },
      };
      observers.push(obs);
      return obs;
    },
  });

  t.after(() => controller.destroy());

  async function pumpFrame(deltaMs = 75) {
    clockMs += deltaMs;
    ui.video.currentTime = +(ui.video.currentTime + deltaMs / 1000).toFixed(3);
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of entries) {
      cb(clockMs);
    }
    await flushAsync();
  }

  return {
    doc,
    ui,
    controller,
    rafQueue,
    engines,
    workers,
    scratchCanvases,
    observers,
    setTracks(tracks) { nextTracks = tracks; },
    advanceClock(ms) { clockMs += ms; },
    pumpFrame,
  };
}

test('bundles exact 3 clips and stays 100% lazy on mount with zero network or worker work', async t => {
  assert.deepEqual(
    LANDING_CLIPS.map(c => ({ id: c.id, label: c.label, mp4: c.mp4, webm: c.webm, poster: c.poster })),
    [
      {
        id: 'starling-murmuration',
        label: 'Flock / Birds',
        mp4: '/clips/starling-murmuration.mp4',
        webm: '/clips/starling-murmuration.webm',
        poster: '/clips/starling-murmuration.jpg',
      },
      {
        id: 'drone-hover',
        label: 'Hovering Quadcopter',
        mp4: '/clips/drone-hover.mp4',
        webm: '/clips/drone-hover.webm',
        poster: '/clips/drone-hover.jpg',
      },
      {
        id: 'gulls-sky',
        label: 'Coastal Gulls',
        mp4: '/clips/gulls-sky.mp4',
        webm: '/clips/gulls-sky.webm',
        poster: '/clips/gulls-sky.jpg',
      },
    ],
  );

  const savedFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('Unexpected fetch'); };
  t.after(() => { globalThis.fetch = savedFetch; });

  const h = createHarness(t);
  await flushAsync();

  assert.equal(fetchCalls, 0);
  assert.equal(h.engines.length, 0, 'DetectionEngine must not allocate before user click');
  assert.equal(h.workers.length, 0, 'v4.1 Web Worker must not start before user click');
  assert.equal(h.scratchCanvases.length, 0, 'scratch canvas must not allocate before user click');
  assert.equal(h.rafQueue.size, 0, 'rAF loop must not run before user click');
  assert.equal(h.ui.video.preload, 'none');
  assert.equal(h.ui.video.poster, '/clips/starling-murmuration.jpg');
  assert.equal(h.ui.video.children.length, 0, 'no <source> tags attached while idle');
  assert.equal(h.ui.video.loads, 0);
  assert.equal(h.ui.video.plays, 0);
  assert.equal(h.ui.playBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(h.ui.root.dataset.aiState, 'idle');
  assert.equal(h.ui.tracksEl.textContent, '0');
  assert.equal(h.ui.probBars.bird.style.width, '0.0%');
  assert.equal(h.ui.probBars.drone.style.width, '0.0%');
  assert.equal(h.ui.probBars.other.style.width, '0.0%');
});

test('accumulates 5-frame v4.1 votes on 320px scratch frames, draws reticles + 1/5..5/5 arcs, and updates bars', async t => {
  const h = createHarness(t);

  // Lazy-start via the "Run v4.1 in browser" button.
  h.ui.playBtn.click();
  assert.equal(h.workers.length, 1);
  assert.equal(h.engines.length, 1);
  assert.equal(h.ui.video.plays, 1);
  assert.deepEqual(
    h.ui.video.children.map(s => ({ src: s.src, type: s.type })),
    [
      { src: '/clips/starling-murmuration.mp4', type: 'video/mp4' },
      { src: '/clips/starling-murmuration.webm', type: 'video/webm' },
    ],
  );

  await flushAsync(); // Let worker "load" settle.
  assert.equal(h.ui.playBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(h.ui.root.dataset.aiState, 'running');

  const worker = h.workers[0];
  worker.autoReplyProbs = { bird: 0.85, drone: 0.10, other: 0.05 };

  // Frames 1..4: collecting 1/5..4/5 without publishing premature class probabilities.
  for (let i = 1; i <= 4; i += 1) {
    h.ui.overlay._ctx.ops.length = 0;
    await h.pumpFrame(75);

    assert.equal(h.scratchCanvases[0].width, 320);
    assert.equal(h.scratchCanvases[0].height, 180);
    assert.equal(h.engines[0].calls.length, i);
    assert.equal(h.ui.tracksEl.textContent, '1');
    assert.ok(Number.parseFloat(h.ui.fpsEl.textContent) >= 12 && Number.parseFloat(h.ui.fpsEl.textContent) <= 15.2);
    assert.match(h.ui.msEl.textContent, /^\d+\.\d ms$/);
    assert.match(h.ui.verdictEl.textContent, new RegExp(`\\(${i}/5\\)`));
    assert.equal(h.ui.verdictEl.dataset.verdict, 'collecting');
    assert.equal(h.ui.probBars.bird.style.width, '0.0%', 'partial votes do not publish class bars');
    assert.equal(h.ui.probBars.bird.dataset.voteState, 'collecting');

    // Verify corner-bracket lines + radial progress arc currently painted on overlay canvas.
    const painted = activeCanvasOps(h.ui.overlay);
    const arcs = painted.filter(op => op.op === 'arc');
    assert.equal(arcs.length, 2, 'draws background track ring + active vote progress arc');
    const expectedEnd = -Math.PI / 2 + (Math.PI * 2 * (i / 5));
    assert.ok(Math.abs(arcs[1].end - expectedEnd) < 1e-6);
    const lines = painted.filter(op => op.op === 'lineTo');
    assert.ok(lines.length >= 8, 'draws 4 L-shaped corner brackets');
  }

  // Frame 5: completes the 5-frame window and publishes mean probabilities!
  worker.autoReplyProbs = { bird: 0.60, drone: 0.30, other: 0.10 };
  h.ui.overlay._ctx.ops.length = 0;
  await h.pumpFrame(75);

  // Mean over 4x(0.85, 0.10, 0.05) + 1x(0.60, 0.30, 0.10) = (0.80, 0.14, 0.06).
  assert.equal(h.ui.verdictEl.dataset.verdict, 'bird');
  assert.match(h.ui.verdictEl.textContent, /Bird .* 80% \(5\/5 frames/i);
  assert.equal(h.ui.probBars.bird.style.width, '80.0%');
  assert.equal(h.ui.probBars.drone.style.width, '14.0%');
  assert.equal(h.ui.probBars.other.style.width, '6.0%');
  assert.equal(h.ui.probBars.bird.style.getPropertyValue('--prob'), '0.800');
  assert.equal(h.ui.probPcts.bird.textContent, '80%');
  assert.equal(h.ui.probPcts.drone.textContent, '14%');
  assert.equal(h.ui.probPcts.other.textContent, '6%');

  const painted = activeCanvasOps(h.ui.overlay);
  const fullArc = painted.filter(op => op.op === 'arc')[1];
  assert.ok(Math.abs(fullArc.end - (-Math.PI / 2 + Math.PI * 2)) < 1e-6);
  const labelOp = painted.find(op => op.op === 'fillText');
  assert.match(labelOp.text, /BIRD 80% .* 5\/5/);
});

test('clip pill click lazy-starts, switches sources/posters, resets votes, and drops stale worker replies', async t => {
  const h = createHarness(t, {
    createWorker() {
      const w = new FakeWorker();
      return w;
    },
  });

  // Lazy-start directly by clicking the "drone-hover" pill without touching the play button first.
  h.ui.clipBtns['drone-hover'].click();
  await flushAsync();

  assert.equal(h.workers.length, 1);
  assert.equal(h.ui.clipBtns['drone-hover'].getAttribute('aria-pressed'), 'true');
  assert.equal(h.ui.clipBtns['starling-murmuration'].getAttribute('aria-pressed'), 'false');
  assert.equal(h.ui.video.poster, '/clips/drone-hover.jpg');
  assert.equal(h.ui.video.children[0].src, '/clips/drone-hover.mp4');
  assert.equal(h.ui.video.children[1].src, '/clips/drone-hover.webm');

  const worker = h.workers[0];
  worker.autoReplyProbs = { bird: 0.04, drone: 0.92, other: 0.04 };
  for (let i = 0; i < 4; i += 1) {
    await h.pumpFrame(75);
  }
  assert.match(h.ui.verdictEl.textContent, /\(4\/5\)/);

  // Hold the 5th classify request in flight, then switch to "gulls-sky" before it resolves.
  worker.manualClassify = true;
  await h.pumpFrame(75);
  const staleClassifyId = worker.messages.at(-1).id;

  h.ui.clipBtns['gulls-sky'].click();
  assert.equal(h.ui.video.poster, '/clips/gulls-sky.jpg');
  assert.equal(h.ui.video.children[0].src, '/clips/gulls-sky.mp4');
  assert.equal(h.ui.video.children[1].src, '/clips/gulls-sky.webm');
  assert.equal(h.ui.probBars.drone.style.width, '0.0%');
  assert.equal(h.engines[0].resets, 1);

  // Resolve the stale drone-hover 5th frame; it must not pollute gulls-sky!
  worker.onmessage({
    data: {
      id: staleClassifyId,
      ok: true,
      results: [{ label: 'drone', score: 0.92, probs: { bird: 0.04, drone: 0.92, other: 0.04 }, ms: 2.1 }],
    },
  });
  await flushAsync();
  assert.notEqual(h.ui.verdictEl.dataset.verdict, 'drone');
  assert.equal(h.ui.probBars.drone.style.width, '0.0%');

  // Subsequent frames on gulls-sky start fresh at 1/5 without worker-busy errors.
  worker.manualClassify = false;
  worker.autoReplyProbs = { bird: 0.94, drone: 0.03, other: 0.03 };
  await h.pumpFrame(75);
  assert.match(h.ui.verdictEl.textContent, /\(1\/5\)/);
});

test('throttles 60Hz rAF ticks to ~12-15 fps and caps worker batches at 8 boxes', async t => {
  const manyTracks = Array.from({ length: 12 }, (_, idx) => ({
    id: idx + 1,
    classification: 'unknown',
    bbox: { x: 0.05 * (idx % 10), y: 0.2, w: 0.04, h: 0.04 },
    missed: false,
    dense: false,
  }));
  const h = createHarness(t, { tracks: manyTracks });

  h.ui.playBtn.click();
  await flushAsync();

  // First tick at +70ms processes frame 1.
  await h.pumpFrame(70);
  assert.equal(h.engines[0].calls.length, 1);
  const classifyMsg = h.workers[0].messages.find(m => m.type === 'classify');
  assert.equal(classifyMsg.boxes.length, 8, 'caps worker batch at skysentry-v41-worker MAX_BOXES = 8');
  assert.equal(h.ui.tracksEl.textContent, '12', 'telemetry still reports all 12 tracked objects');

  // Sub-66ms ticks (16ms, 32ms, 48ms) are throttled and do not run DetectionEngine.
  await h.pumpFrame(16);
  await h.pumpFrame(16);
  await h.pumpFrame(16);
  assert.equal(h.engines[0].calls.length, 1);

  // Next +20ms (total 68ms >= 66ms) processes frame 2.
  await h.pumpFrame(20);
  assert.equal(h.engines[0].calls.length, 2);
});

test('pauses automatically when scrolled offscreen or document.hidden, and cleans up on destroy()', async t => {
  const h = createHarness(t);

  h.ui.playBtn.click();
  await flushAsync();
  await h.pumpFrame(75);
  assert.equal(h.engines[0].calls.length, 1);
  assert.ok(h.rafQueue.size > 0);

  // Scroll completely offscreen -> IntersectionObserver pauses loop and video.
  const pausesBefore = h.ui.video.pauses;
  h.observers[0].trigger(false, 0);
  assert.equal(h.rafQueue.size, 0, 'offscreen cancels scheduled rAF');
  assert.equal(h.ui.video.pauses, pausesBefore + 1);
  assert.equal(h.ui.root.dataset.aiState, 'offscreen');
  assert.match(h.ui.verdictEl.textContent, /Paused offscreen/i);

  // Scroll back onscreen -> resumes automatically.
  h.observers[0].trigger(true, 0.4);
  assert.equal(h.ui.root.dataset.aiState, 'running');
  assert.ok(h.rafQueue.size > 0);

  // Tab hidden -> pauses immediately.
  h.doc.hidden = true;
  h.doc.dispatchEvent('visibilitychange');
  assert.equal(h.rafQueue.size, 0);
  assert.equal(h.ui.video.paused, true);

  // Tab visible again -> resumes unless user explicitly paused.
  h.doc.hidden = false;
  h.doc.dispatchEvent('visibilitychange');
  assert.ok(h.rafQueue.size > 0);

  // Explicit user pause stays paused across visibility/intersection transitions.
  h.ui.playBtn.click();
  assert.equal(h.ui.root.dataset.aiState, 'paused');
  assert.equal(h.rafQueue.size, 0);
  h.observers[0].trigger(false, 0);
  h.observers[0].trigger(true, 1);
  assert.equal(h.ui.root.dataset.aiState, 'paused');
  assert.equal(h.rafQueue.size, 0);

  // Clean destroy() closes worker, disconnects observer, clears video & scratch canvas, and is idempotent.
  const scratch = h.scratchCanvases[0];
  const worker = h.workers[0];
  h.controller.destroy();
  h.controller.destroy();

  assert.equal(h.observers[0].disconnected, true);
  assert.equal(worker.terminations, 1);
  assert.equal(h.ui.video.children.length, 0);
  assert.equal(scratch.width, 0);
  assert.equal(scratch.height, 0);
  assert.equal(h.controller.getState().destroyed, true);

  // Post-destroy clicks are inert.
  h.ui.playBtn.click();
  assert.equal(h.workers.length, 1);
});

test('auto-mounts #landingLiveAi on DOMContentLoaded and scaffolds default DOM when empty', async () => {
  const doc = createFakeDocument({ readyState: 'loading' });
  const emptyRoot = new FakeElement('div');
  emptyRoot.setAttribute('id', 'landingLiveAi');
  doc.append(emptyRoot);

  setupLandingLiveAiAutoMount(doc);
  assert.equal(emptyRoot.children.length, 0, 'waits for DOMContentLoaded while document is loading');

  doc.readyState = 'interactive';
  doc.dispatchEvent('DOMContentLoaded');

  const overlay = emptyRoot.querySelector('[data-live-ai-overlay]');
  const playBtn = emptyRoot.querySelector('[data-live-ai-play]');
  const pills = emptyRoot.querySelectorAll('[data-clip]');
  assert.ok(overlay, 'scaffolded [data-live-ai-overlay] canvas');
  assert.ok(playBtn, 'scaffolded [data-live-ai-play] button');
  assert.equal(pills.length, 3, 'scaffolded all 3 clip pills');
  assert.equal(emptyRoot.dataset.aiState, 'idle', 'auto-mount stays lazy until user clicks');

  const handle = mountLandingLiveAi(emptyRoot, { document: doc });
  handle.destroy();
});

test('integrates end-to-end with real DetectionEngine + createV41Votes + createV41WorkerClient', async t => {
  const doc = createFakeDocument();
  const ui = buildWidgetFixture(doc);

  let clockMs = 5000;
  let rafCb = null;
  let frameIndex = 0;
  const workers = [];

  // Scratch canvas draws a synthetic bright sky with a dark moving quadcopter blob.
  const scratch = createFakeCanvas(0, 0);
  const baseCtx = scratch.getContext();
  scratch.getContext = () => ({
    ...baseCtx,
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < data.length; p += 4) {
        data[p] = 185;
        data[p + 1] = 205;
        data[p + 2] = 230;
        data[p + 3] = 255;
      }
      // After the 15-frame MotionDetector background warm-up, move an 8x8 dark object across the sky.
      if (frameIndex >= 15) {
        const bx = 40 + (frameIndex - 15) * 4;
        const by = 50;
        for (let dy = 0; dy < 8; dy += 1) {
          for (let dx = 0; dx < 8; dx += 1) {
            const px = bx + dx;
            const py = by + dy;
            if (px >= 0 && px < w && py >= 0 && py < h) {
              const off = (py * w + px) * 4;
              data[off] = 20;
              data[off + 1] = 24;
              data[off + 2] = 28;
            }
          }
        }
      }
      frameIndex += 1;
      return { width: w, height: h, data };
    },
  });

  const controller = mountLandingLiveAi(ui.root, {
    document: doc,
    now: () => clockMs,
    getDevicePixelRatio: () => 1,
    requestFrame(cb) { rafCb = cb; return 1; },
    cancelFrame() { rafCb = null; },
    createScratchCanvas: () => scratch,
    createWorkerClient() {
      return createV41WorkerClient({
        createWorker() {
          const w = new FakeWorker();
          w.autoReplyProbs = { bird: 0.03, drone: 0.93, other: 0.04 };
          workers.push(w);
          return w;
        },
      });
    },
    createObserver: () => null,
  });
  t.after(() => controller.destroy());

  ui.clipBtns['drone-hover'].click();
  await flushAsync();

  for (let step = 0; step < 30 && ui.verdictEl.dataset.verdict !== 'drone'; step += 1) {
    clockMs += 80;
    ui.video.currentTime = +(ui.video.currentTime + 0.08).toFixed(3);
    const cb = rafCb;
    rafCb = null;
    cb?.(clockMs);
    await flushAsync();
  }

  assert.equal(ui.verdictEl.dataset.verdict, 'drone');
  assert.match(ui.verdictEl.textContent, /Drone .* 93% \(5\/5 frames/i);
  assert.equal(ui.probBars.drone.style.width, '93.0%');
  assert.equal(ui.probPcts.drone.textContent, '93%');
});

test('recovers cleanly from a worker load failure and resets partial votes on video loop', async t => {
  let attempt = 0;
  const h = createHarness(t, {
    createWorker() {
      attempt += 1;
      const w = new FakeWorker();
      if (attempt === 1) {
        w.manualLoad = true;
        queueMicrotask(() => w.replyLatest({ ok: false, error: 'weights HTTP 503' }));
      }
      return w;
    },
  });

  // First click fails worker load, keeping motion tracking alive without crashing.
  h.ui.playBtn.click();
  await flushAsync();
  await h.pumpFrame(75);
  assert.equal(h.engines[0].calls.length, 1, 'DetectionEngine keeps running when v4.1 fails to load');
  assert.equal(h.ui.verdictEl.dataset.verdict, 'error');

  // Clicking play retries with a fresh worker and succeeds.
  h.ui.playBtn.click();
  await flushAsync();
  assert.equal(h.workers.length, 2);

  for (let i = 1; i <= 3; i += 1) {
    await h.pumpFrame(75);
  }
  assert.match(h.ui.verdictEl.textContent, /\(3\/5\)/);

  // Simulate video looping back to t=0.05s: partial 3/5 vote resets cleanly to 1/5.
  h.advanceClock(75);
  h.ui.video.currentTime = 0.05;
  const entries = [...h.rafQueue.entries()];
  h.rafQueue.clear();
  for (const [, cb] of entries) cb(5000);
  await flushAsync();

  assert.match(h.ui.verdictEl.textContent, /\(1\/5\)/);
});

