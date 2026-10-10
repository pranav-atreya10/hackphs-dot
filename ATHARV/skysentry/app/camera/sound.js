// Drone listener plug-in point (prompt D3). Every listener has the same shape:
//
//   { name, load(): Promise<void>, start(onScores): Promise<void>, stop(): void }
//
// onScores receives { background, drone, birds } as 0..1 scores, several times a second.
//
//   teachable  a Teachable Machine audio model: train classes "Background Noise", "Drone",
//              "Birds" (record background noise in the actual hackathon room), export, paste the URL
//   simulated  press D on the camera page to fake a drone sound
//   off        microphone disabled

const loadScript = src => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) return resolve();
  const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
  document.head.appendChild(s);
});

export function teachableListener(modelUrl) {
  let recognizer = null;
  const base = modelUrl.endsWith('/') ? modelUrl : modelUrl + '/';
  return {
    name: 'Teachable Machine audio',
    async load() {
      if (!modelUrl) throw new Error('Paste your Teachable Machine audio model URL first.');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/speech-commands@0.5.4/dist/speech-commands.min.js');
      recognizer = window.speechCommands.create('BROWSER_FFT', undefined, base + 'model.json', base + 'metadata.json');
      await recognizer.ensureModelLoaded();
    },
    async start(onScores) {
      const labels = recognizer.wordLabels().map(l => l.toLowerCase());
      const find = word => labels.findIndex(l => l.includes(word));
      const iBg = find('background'), iDrone = find('drone'), iBirds = find('bird');
      await recognizer.listen(r => {
        const s = r.scores;
        onScores({ background: s[iBg] ?? 0, drone: s[iDrone] ?? 0, birds: s[iBirds] ?? 0 });
      }, { probabilityThreshold: 0, overlapFactor: 0.5, invokeCallbackOnNoiseAndUnknown: true });
    },
    stop() { recognizer?.stopListening().catch(() => {}); }
  };
}

export function simulatedListener() {
  let timer = null, held = false;
  const down = e => { if (e.key.toLowerCase() === 'd') held = true; }, up = e => { if (e.key.toLowerCase() === 'd') held = false; };
  return {
    name: 'Simulated (hold D for a drone)',
    async load() {},
    async start(onScores) {
      addEventListener('keydown', down); addEventListener('keyup', up);
      timer = setInterval(() => onScores(held ? { background: .05, drone: .92, birds: .03 } : { background: .9, drone: .04 + Math.random() * .05, birds: .03 }), 200);
    },
    stop() { clearInterval(timer); removeEventListener('keydown', down); removeEventListener('keyup', up); }
  };
}

export function createListener(kind, modelUrl) {
  if (kind === 'teachable') return teachableListener(modelUrl);
  if (kind === 'simulated') return simulatedListener();
  return { name: 'Microphone off', async load() {}, async start() {}, stop() {} };
}
