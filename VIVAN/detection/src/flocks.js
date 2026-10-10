// Flock grouping: confirmed tracks that are close together and flying the same
// way become one flock. Flock IDs stay stable across frames by matching each new
// group to the previous flock it shares the most members with.

import { angleDiffDeg } from './geometry.js';

export class FlockGrouper {
  constructor(cfg) {
    this.cfg = cfg;
    this.prev = new Map(); // flockId -> Set(trackId)
    this.nextId = 1;
  }

  reset() {
    this.prev.clear();
  }

  // tracks: confirmed, non-rejected internal tracks (pixel units). width: frame width in px.
  group(tracks, width) {
    const c = this.cfg;
    const n = tracks.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const radius = c.radiusFrac * width;

    for (let i = 0; i < n; i++) {
      const a = tracks[i];
      const sa = Math.hypot(a.svx, a.svy);
      for (let j = i + 1; j < n; j++) {
        const b = tracks[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) > radius) continue;
        const sb = Math.hypot(b.svx, b.svy);
        if (sa >= c.minSpeed && sb >= c.minSpeed) {
          const ha = (Math.atan2(a.svy, a.svx) * 180) / Math.PI;
          const hb = (Math.atan2(b.svy, b.svx) * 180) / Math.PI;
          if (angleDiffDeg(ha, hb) > c.maxHeadingDiff) continue;
        } else if ((sa >= c.minSpeed) !== (sb >= c.minSpeed)) {
          continue; // one moving, one hovering: not travelling together
        }
        parent[find(i)] = find(j);
      }
    }

    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(tracks[i]);
    }
    const list = [...groups.values()].filter((g) => g.length >= c.minSize);

    // Stable IDs: match new groups to previous flocks by shared members, biggest overlap first.
    const cand = [];
    list.forEach((g, gi) => {
      for (const [fid, members] of this.prev) {
        let shared = 0;
        for (const tr of g) if (members.has(tr.id)) shared++;
        if (shared) cand.push([shared, gi, fid]);
      }
    });
    cand.sort((a, b) => b[0] - a[0]);
    const ids = new Array(list.length).fill(null);
    const taken = new Set();
    for (const [, gi, fid] of cand) {
      if (ids[gi] || taken.has(fid)) continue;
      ids[gi] = fid;
      taken.add(fid);
    }

    const flocks = list.map((members, gi) => {
      const id = ids[gi] || `f${this.nextId++}`;
      let x = 0, y = 0, vx = 0, vy = 0, seX = 0, seY = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const tr of members) {
        x += tr.x; y += tr.y; vx += tr.svx; vy += tr.svy;
        seX += Number.isFinite(tr.seX) ? tr.seX : 0;
        seY += Number.isFinite(tr.seY) ? tr.seY : 0;
        const b = tr.blob;
        minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
      }
      const k = members.length;
      // Averaging k members' velocities shrinks the error by about sqrt(k).
      return {
        id, members, size: k, x: x / k, y: y / k, vx: vx / k, vy: vy / k,
        seX: seX / k / Math.sqrt(k), seY: seY / k / Math.sqrt(k),
        bbox: { minX, minY, maxX, maxY },
      };
    });

    this.prev = new Map(flocks.map((f) => [f.id, new Set(f.members.map((m) => m.id))]));
    return flocks;
  }
}
