const MAX_PIXELS = 8_000_000;
const MAX_BOXES = 8;
const MAX_BOX_SIDE = 4096;
const CLASSES = ['bird', 'drone', 'other'];
const CHANNELS = [3, 32, 32, 64, 64, 128, 128, 160];
let classifierPromise;

function isTensor(encoded, values) {
  const size = values * 4;
  if (typeof encoded !== 'string' || encoded.length !== Math.ceil(size / 3) * 4) return false;
  let bytes;
  try { bytes = atob(encoded); } catch { return false; }
  if (bytes.length !== size) return false;
  for (let i = 0; i < size; i += 4) {
    // An all-ones exponent in a little-endian float32 encodes Infinity or NaN.
    if ((bytes.charCodeAt(i + 3) & 0x7f) === 0x7f && (bytes.charCodeAt(i + 2) & 0x80)) return false;
  }
  return true;
}

function validWeights(spec) {
  const rgb = values => Array.isArray(values) && values.length === 3 && values.every(Number.isFinite);
  return spec?.version === 1 && spec.input === 64 &&
    Array.isArray(spec.classes) && spec.classes.length === CLASSES.length &&
    CLASSES.every(label => spec.classes.includes(label)) &&
    rgb(spec.mean) && rgb(spec.std) && spec.std.every(value => value > 0) &&
    spec.crop?.context === 1.4 && spec.crop.min_side === 32 &&
    Array.isArray(spec.layers) && spec.layers.length === CHANNELS.length - 1 &&
    spec.layers.every((layer, i) => layer?.cin === CHANNELS[i] && layer.cout === CHANNELS[i + 1] &&
      layer.stride === (i === 0 ? 2 : 1) && layer.pool === (i % 2 === 1) &&
      isTensor(layer.weight_b64, layer.cin * layer.cout * 9) && isTensor(layer.bias_b64, layer.cout)) &&
    isTensor(spec.fc?.weight_b64, CLASSES.length * CHANNELS[CHANNELS.length - 1]) &&
    isTensor(spec.fc?.bias_b64, CLASSES.length);
}

async function load() {
  const { loadClassifier } = await import('/ai-models/skysentry_classifier.js');
  const response = await fetch('/ai-models/skysentry_classifier.json', { mode: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load v4.1 weights (HTTP ${response.status})`);
  const spec = await response.json().catch(() => { throw new Error('Invalid v4.1 weights JSON'); });
  if (!validWeights(spec)) throw new Error('Malformed v4.1 model weights');
  return loadClassifier(spec);
}

function getClassifier() {
  // Share initialization as well as the classifier's reusable buffers; allow retry after failure.
  classifierPromise ??= load().catch(error => {
    classifierPromise = undefined;
    throw error;
  });
  return classifierPromise;
}

function validateBatch(frame, boxes) {
  const { data, width, height } = frame ?? {};
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('Frame dimensions must be positive integers');
  }
  const pixels = width * height;
  if (pixels > MAX_PIXELS) throw new Error('Frame exceeds 8 megapixels');
  if (!(data instanceof Uint8ClampedArray) || data.length !== pixels * 4) {
    throw new Error('Frame must contain exactly width * height * 4 RGBA bytes as a Uint8ClampedArray');
  }
  if (!Array.isArray(boxes) || boxes.length > MAX_BOXES) throw new Error('Expected an array of up to 8 boxes');
  for (const box of boxes) {
    const { x, y, w, h } = box ?? {};
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 ||
      x + w > 1.001 || y + h > 1.001) {
      throw new Error('Expected a normalized box with positive area inside the frame');
    }
    // Square-padding a long, thin box can otherwise exceed the frame's pixel budget many times over.
    if (Math.max(w * width, h * height) > MAX_BOX_SIDE) throw new Error('Box exceeds 4096 pixels on one side');
  }
  return { data, width, height };
}

self.addEventListener('message', async ({ data: request }) => {
  const requestId = request?.id;
  const id = Number.isSafeInteger(requestId) || (typeof requestId === 'string' && requestId.length > 0)
    ? requestId : null;
  try {
    if (id === null) throw new Error('Expected a request id (integer or nonempty string)');
    if (request.type === 'load') {
      await getClassifier();
      self.postMessage({ id, ok: true });
    } else if (request.type === 'classify') {
      const frame = validateBatch(request.frame, request.boxes);
      const classifier = await getClassifier();
      const results = classifier.classifyBoxes(frame, request.boxes).map(({ label, score, probs, ms }) => {
        const { bird, drone, other } = probs;
        if (![bird, drone, other].every(Number.isFinite)) throw new Error('Classifier returned invalid probabilities');
        return { label, score, probs: { bird, drone, other }, ms };
      });
      self.postMessage({ id, ok: true, results });
    } else {
      throw new Error('Unknown request type');
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'v4.1 worker failed' });
  }
});
