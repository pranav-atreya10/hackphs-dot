// Shared TensorFlow.js loader for the browser adapters.
//
// One TF.js instance per page: COCO-SSD and the Teachable Machine drone-sound model
// (speech-commands) both attach to window.tf. Two copies would fight over the GPU
// and double the memory, so everything loads through here.
//
// Versions: TF.js 3.x is the newest line speech-commands supports, and coco-ssd 2.2.2
// is the last coco-ssd built for TF.js 3. Upgrading TF.js to 4 means upgrading
// coco-ssd to 2.2.3 and dropping (or re-testing) the audio model.

export const CDN = {
  tfjs: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.21.0/dist/tf.min.js',
  cocoSsd: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js',
  speechCommands: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.5.4/dist/speech-commands.min.js',
};

const loading = new Map();

export function loadScript(src) {
  if (loading.has(src)) return loading.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => {
      loading.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(s);
  });
  loading.set(src, p);
  return p;
}

// backend: 'webgl' (GPU, default and fastest on phones), 'wasm', or 'cpu' (slow fallback).
export async function loadTensorFlow({ backend, scriptUrl = CDN.tfjs } = {}) {
  if (!window.tf) await loadScript(scriptUrl);
  const tf = window.tf;
  const major = Number(String(tf.version && tf.version.tfjs).split('.')[0]);
  if (major !== 3) console.warn(`[skysentry] TF.js ${tf.version.tfjs} already on the page; adapters were tested with 3.21.0`);
  if (backend && tf.getBackend() !== backend) {
    try { await tf.setBackend(backend); } catch (e) { console.warn(`[skysentry] backend ${backend} unavailable, using ${tf.getBackend()}`); }
  }
  await tf.ready();
  return { tf, backend: tf.getBackend(), version: tf.version.tfjs };
}

// Width/height of anything COCO-SSD can read: <video>, <canvas>, <img>, ImageBitmap.
export function sourceSize(el) {
  if (!el) return null;
  const width = el.videoWidth || el.naturalWidth || el.width;
  const height = el.videoHeight || el.naturalHeight || el.height;
  return width && height ? { width, height } : null;
}
