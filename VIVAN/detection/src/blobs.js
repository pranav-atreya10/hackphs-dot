// Connected-component labeling: group neighbouring changed pixels into blobs.
//
// 1. Flood-fill components on the dilated mask (so a bird's wings join its body).
// 2. Measure each component on the raw mask (dilation would blur the wingbeat signal),
//    keeping raw totals (count, Σx, Σy, Σx², Σy², Σxy, Σcontrast) so pieces can be merged exactly.
// 3. Merge small components whose boxes nearly touch: a wing tip that broke off its body
//    when the wings folded. Done before the size filter, since a tip alone may be under minArea.
// 4. Turn totals into position, size, shape; drop specks and giant regions.

export class BlobLabeler {
  constructor() {
    this.n = 0;
  }

  ensure(n) {
    if (n === this.n) return;
    this.n = n;
    this.labels = new Int32Array(n);
    this.stack = new Int32Array(n);
  }

  // bin: dilated mask, raw: raw mask, diff: |gray - bg|, all length w*h.
  // Returns { blobs, overflow, merged, components }.
  label(bin, raw, diff, w, h, opts) {
    this.ensure(w * h);
    const { labels, stack } = this;
    labels.fill(0);
    const comps = [];
    let next = 0;

    for (let start = 0; start < w * h; start++) {
      if (!bin[start] || labels[start]) continue;
      next++;
      if (next > opts.maxBlobs) return { blobs: [], overflow: true, merged: 0, components: next };
      let sp = 0;
      stack[sp++] = start;
      labels[start] = next;
      const c = { parts: [next], n: 0, mass: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, minX: w, minY: h, maxX: -1, maxY: -1 };

      while (sp > 0) {
        const p = stack[--sp];
        const y = (p / w) | 0;
        const x = p - y * w;
        c.mass += diff[p];
        if (raw[p]) {
          c.n++;
          c.sx += x; c.sy += y;
          c.sxx += x * x; c.syy += y * y; c.sxy += x * y;
          if (x < c.minX) c.minX = x;
          if (x > c.maxX) c.maxX = x;
          if (y < c.minY) c.minY = y;
          if (y > c.maxY) c.maxY = y;
        }
        const yLo = y > 0 ? -1 : 0, yHi = y < h - 1 ? 1 : 0;
        const xLo = x > 0 ? -1 : 0, xHi = x < w - 1 ? 1 : 0;
        for (let dy = yLo; dy <= yHi; dy++) {
          const rowBase = p + dy * w;
          for (let dx = xLo; dx <= xHi; dx++) {
            const q = rowBase + dx;
            if (bin[q] && !labels[q]) {
              labels[q] = next;
              stack[sp++] = q;
            }
          }
        }
      }
      if (c.n > 0) comps.push(c);
    }

    const merged = opts.mergeGap > 0 ? mergeNearby(comps, opts) : comps;
    const maxArea = opts.maxAreaFrac * w * h;
    const blobs = [];
    for (const c of merged) {
      if (c.n < opts.minArea || c.n > maxArea) continue;
      blobs.push(finalize(c));
    }
    return { blobs, overflow: false, merged: comps.length - merged.length, components: comps.length };
  }
}

// Union-find over components whose bounding boxes are within `mergeGap` px.
function mergeNearby(comps, opts) {
  const n = comps.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const g = opts.mergeGap;
  for (let i = 0; i < n; i++) {
    const a = comps[i];
    if (a.n > opts.mergeMaxArea) continue;
    for (let j = i + 1; j < n; j++) {
      const b = comps[j];
      if (b.n > opts.mergeMaxArea) continue;
      const gapX = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1;
      const gapY = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1;
      if (gapX <= g && gapY <= g && a.n + b.n <= opts.mergeMaxArea) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const c = comps[i];
    const m = groups.get(r);
    if (!m) { groups.set(r, { ...c, parts: [...c.parts] }); continue; }
    m.parts.push(...c.parts);
    m.n += c.n; m.mass += c.mass;
    m.sx += c.sx; m.sy += c.sy; m.sxx += c.sxx; m.syy += c.syy; m.sxy += c.sxy;
    m.minX = Math.min(m.minX, c.minX); m.minY = Math.min(m.minY, c.minY);
    m.maxX = Math.max(m.maxX, c.maxX); m.maxY = Math.max(m.maxY, c.maxY);
  }
  return [...groups.values()];
}

function finalize(c) {
  const area = c.n;
  const cx = c.sx / area;
  const cy = c.sy / area;
  const vxx = c.sxx / area - cx * cx;
  const vyy = c.syy / area - cy * cy;
  const vxy = c.sxy / area - cx * cy;
  const half = (vxx + vyy) / 2;
  const root = Math.sqrt(Math.max(0, ((vxx - vyy) / 2) ** 2 + vxy * vxy));
  return {
    parts: c.parts,                                 // component label ids (for ghost checks)
    x: cx + 0.5,
    y: cy + 0.5,
    area,
    mass: c.mass,                                   // Σ|pixel - background|: smooth size signal
    meanContrast: c.mass / area,
    major: Math.sqrt(Math.max(0, half + root)) * 4, // ~full length along the long axis
    minor: Math.sqrt(Math.max(0, half - root)) * 4,
    minX: c.minX, minY: c.minY, maxX: c.maxX + 1, maxY: c.maxY + 1,
  };
}
