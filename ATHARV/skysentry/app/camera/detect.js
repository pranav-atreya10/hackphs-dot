// Bird detector plug-in point. Every detector has the same shape:
//
//   { name, load(): Promise<void>, detect(source): Promise<Box[]> }
//
// where source is a <video> (webcam or test clip) and each Box is
//   { x, y, width, height, score }   in source pixels, birds only.
//
// Three detectors ship here:
//   coco-ssd   the free TensorFlow.js model from the build plan (prompt D1)
//   simulated  moving fake birds, for testing the pipeline with no model and no birds
//   custom     your own model: fill in models/custom.js, nothing else needs to change

const loadScript = src => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) return resolve();
  const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
  document.head.appendChild(s);
});

export function cocoSsdDetector({ minScore = 0.35 } = {}) {
  let model = null;
  return {
    name: 'COCO-SSD (TensorFlow.js)',
    async load() {
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
      model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
    },
    async detect(source) {
      const preds = await model.detect(source, 20, minScore);
      return preds.filter(p => p.class === 'bird').map(p => ({ x: p.bbox[0], y: p.bbox[1], width: p.bbox[2], height: p.bbox[3], score: p.score }));
    }
  };
}

export function simulatedDetector() {
  // A small flock drifts right-to-left (toward the runway side) every 20 seconds, then the sky clears.
  const start = performance.now();
  return {
    name: 'Simulated birds (no model)',
    async load() {},
    async detect(source) {
      const w = source.videoWidth || 640, h = source.videoHeight || 480, t = ((performance.now() - start) / 1000) % 20;
      if (t > 14) return [];
      const n = t < 4 ? 2 : t < 8 ? 4 : 7;
      return Array.from({ length: n }, (_, i) => {
        const x = w * (0.95 - t / 14) + (i % 3) * 38 + Math.sin(t * 2 + i) * 4, y = h * 0.25 + (i * 23) % 120;
        return { x, y, width: 34, height: 22, score: 0.7 + ((i * 7) % 25) / 100 };
      }).filter(b => b.x > -30 && b.x < w);
    }
  };
}

export async function createDetector(kind) {
  if (kind === 'coco-ssd') return cocoSsdDetector();
  if (kind === 'custom') { const m = await import('./models/custom.js'); return m.customDetector(); }
  return simulatedDetector();
}
