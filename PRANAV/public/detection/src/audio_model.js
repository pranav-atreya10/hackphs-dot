// Trained drone-sound detector, running in plain JavaScript (no ML library needed).
//
// This is the same small network the benchmarks trained and tested (benchmarks/train/train_audio.py),
// exported by benchmarks/export_audio_web.py into models/drone_audio_v0.json. It is much more accurate
// than the hand-made HumDetector because it learned what drones sound like from thousands of recordings.
//
// How it hears, step by step (every 0.5 s, on the last 1 s of 16 kHz audio):
//   1. Spectrogram: 101 short slices of sound (64 ms each, every 10 ms), each split into frequencies.
//   2. Mel scale: squeeze the frequencies into 64 bands spaced like human hearing, then take the log.
//   3. Four filter layers (3x3 convolution + ReLU + halve the size) look for drone-like patterns.
//   4. Average everything into one score; a sigmoid turns it into a 0..1 drone probability.
// The engine's usual rule then applies: probability >= 0.8 held for 1 s = "drone heard".

function decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export class DroneAudioModel {
  constructor(spec) {
    const f = spec.frontend;
    this.name = spec.name;
    this.sr = f.sr;
    this.nFft = f.n_fft;
    this.hop = f.hop;
    this.nMels = f.n_mels;
    this.windowSamples = Math.round(f.sr * f.window_s);
    this.eps = f.log_eps;
    this.mean = f.norm_mean;
    this.std = f.norm_std;
    this.fb = decode(f.mel_fb);                    // nMels x (nFft/2+1), row-major
    this.nBins = f.mel_fb_shape[1];
    this.layers = spec.conv.map((l) => ({ out: l.out, in: l.in, w: decode(l.w), b: decode(l.b) }));
    this.linW = decode(spec.linear.w);
    this.linB = spec.linear.b;
    this.reference = spec.reference;
    this.hann = new Float32Array(this.nFft).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.nFft));
    this.re = new Float64Array(this.nFft);
    this.im = new Float64Array(this.nFft);
  }

  // In a browser: await DroneAudioModel.load('/detection/models/drone_audio_v0.json')
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio model: HTTP ${res.status}`);
    return new DroneAudioModel(await res.json());
  }

  // samples: Float32Array of 16 kHz audio, at least 1 s long (the last 1 s is used).
  // Returns { prob, logit }.
  predict(samples) {
    const x = this.logMel(samples.length > this.windowSamples ? samples.subarray(samples.length - this.windowSamples) : samples);
    const logit = this.network(x);
    return { prob: 1 / (1 + Math.exp(-logit)), logit };
  }

  // Log-mel spectrogram, normalized like training. Returns { data, h: nMels, w: frames }.
  logMel(y) {
    const n = y.length, N = this.nFft, half = N >> 1, hop = this.hop;
    const frames = 1 + Math.floor(n / hop);
    const at = (i) => (i < 0 ? y[-i] : i >= n ? y[2 * n - 2 - i] : y[i]); // centred frames, reflect padding
    const out = new Float32Array(this.nMels * frames);
    const power = new Float64Array(this.nBins);
    for (let f = 0; f < frames; f++) {
      const start = f * hop - half;
      for (let i = 0; i < N; i++) { this.re[i] = at(start + i) * this.hann[i]; this.im[i] = 0; }
      fft(this.re, this.im);
      for (let k = 0; k < this.nBins; k++) power[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      for (let m = 0; m < this.nMels; m++) {
        let s = 0;
        const row = m * this.nBins;
        for (let k = 0; k < this.nBins; k++) s += this.fb[row + k] * power[k];
        out[m * frames + f] = (Math.log(s + this.eps) - this.mean) / this.std;
      }
    }
    return { data: out, h: this.nMels, w: frames };
  }

  network(x) {
    let cur = x, ch = 1;
    for (const L of this.layers) {
      cur = maxPool2(relu(conv3x3(cur.data, ch, cur.h, cur.w, L)), L.out);
      ch = L.out;
    }
    // Average each channel over the remaining grid, then the final linear layer.
    const area = cur.h * cur.w;
    let logit = this.linB;
    for (let c = 0; c < ch; c++) {
      let s = 0;
      for (let i = 0; i < area; i++) s += cur.data[c * area + i];
      logit += this.linW[c] * (s / area);
    }
    return logit;
  }
}

// 3x3 convolution, zero padding 1, batch-norm already folded into w/b. Returns { data, h, w }.
function conv3x3(input, cin, h, w, L) {
  const out = new Float32Array(L.out * h * w);
  for (let o = 0; o < L.out; o++) {
    const ob = o * h * w;
    out.fill(L.b[o], ob, ob + h * w);
    for (let c = 0; c < cin; c++) {
      const ib = c * h * w, wb = (o * cin + c) * 9;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const wv = L.w[wb + ky * 3 + kx];
          if (wv === 0) continue;
          const dy = ky - 1, dx = kx - 1;
          const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy), x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
          for (let yy = y0; yy < y1; yy++) {
            const orow = ob + yy * w, irow = ib + (yy + dy) * w + dx;
            for (let xx = x0; xx < x1; xx++) out[orow + xx] += wv * input[irow + xx];
          }
        }
      }
    }
  }
  return { data: out, h, w, c: L.out };
}

function relu(t) {
  const d = t.data;
  for (let i = 0; i < d.length; i++) if (d[i] < 0) d[i] = 0;
  return t;
}

// 2x2 max pooling, rounding down like PyTorch.
function maxPool2(t, ch) {
  const h2 = t.h >> 1, w2 = t.w >> 1;
  const out = new Float32Array(ch * h2 * w2);
  for (let c = 0; c < ch; c++) {
    const ib = c * t.h * t.w, ob = c * h2 * w2;
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const i = ib + 2 * y * t.w + 2 * x;
        out[ob + y * w2 + x] = Math.max(t.data[i], t.data[i + 1], t.data[i + t.w], t.data[i + t.w + 1]);
      }
    }
  }
  return { data: out, h: h2, w: w2 };
}

// In-place radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Deterministic test signals matching benchmarks/export_audio_web.py (for checking the port).
export function referenceSignal(name, sr = 16000) {
  const y = new Float32Array(sr);
  if (name === 'lcg_noise') {
    let s = 12345;
    // Exact 32-bit integer maths (a plain multiply would overflow JavaScript's 53-bit precision).
    for (let i = 0; i < sr; i++) { s = (Math.imul(1103515245, s) + 12345) & 0x7fffffff; y[i] = (s / 2147483648 - 0.5) * 0.2; }
    return y;
  }
  for (let i = 0; i < sr; i++) {
    const t = i / sr;
    y[i] = name === 'tone_260hz'
      ? 0.1 * (Math.sin(2 * Math.PI * 260 * t) + Math.sin(2 * Math.PI * 520 * t) / 2 + Math.sin(2 * Math.PI * 780 * t) / 3)
      : 0.1 * Math.sin(2 * Math.PI * (300 * t + 1500 * t * t));
  }
  return y;
}
