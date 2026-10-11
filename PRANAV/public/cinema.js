import { Sky } from 'three/addons/objects/Sky.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Cinematic pass: physical sky, lens and film response, particles, and a second
// layer of airfield and countryside detail. Shots and timeline stay in index.html.
export function enhanceCinema({T, scene, renderer, camera, W, sun, rnd}) {
  const D = new T.Group(); D.name = 'Cinematic detail'; scene.add(D);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const materialCache = new Map();
  const std = (c,o) => {const key=JSON.stringify([c,o||{}]);if(!materialCache.has(key))materialCache.set(key,new T.MeshStandardMaterial(Object.assign({color:c,roughness:.8,metalness:0},o||{})));return materialCache.get(key);};
  const metal = std(0x8d9498, {metalness:.7, roughness:.42}), dark = std(0x2a3238, {roughness:.6});
  const add = (geo, mat, x, y, z, p = D, cast = true) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; p.add(m); return m; };
  const B = (w, h, d, m, x, y, z, p) => add(new T.BoxGeometry(w, h, d), m, x, y, z, p);
  const C = (r, h, m, x, y, z, p, r2 = r, seg = 10) => add(new T.CylinderGeometry(r, r2, h, seg), m, x, y, z, p);
  const rod = (a, b, r, m = metal, p = D) => { const s = new T.Vector3(...a), e = new T.Vector3(...b), d = e.clone().sub(s); const o = C(r, d.length(), m, ...s.clone().add(e).multiplyScalar(.5).toArray(), p, r, 6); o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize()); return o; };
  const canvasTex = (w, h, draw, srgb = true) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new T.CanvasTexture(c); if (srgb) t.colorSpace = T.SRGBColorSpace; t.anisotropy = maxAniso; return t; };
  const label = (text, bg, fg, w = 256, h = 256, size = 170) => new T.MeshStandardMaterial({roughness:.6, map:canvasTex(w, h, (c) => { c.fillStyle = bg; c.fillRect(0, 0, w, h); c.fillStyle = fg; c.font = `700 ${size}px Arial`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w/2, h/2 + 8); })});
  // Same terrain function as the base film, so new scenery sits on the hills.
  const heightAt = (x, z) => { const d = Math.hypot(Math.max(0, Math.abs(x) - 540), Math.max(0, Math.abs(z) - 250)); const n = Math.sin(x*.004)*Math.cos(z*.005) + .5*Math.sin(x*.011 + z*.007); return d > 0 ? (n + 1.3)*Math.min(1, d/420)*34 : 0; };
  const sunDir = new T.Vector3(-180, 320, 140).normalize();

  /* ---------- Physical sky, captured once into a cube map ---------- */
  const sky = new Sky(); sky.scale.setScalar(10000);
  Object.assign(sky.material.uniforms.turbidity, {value:5.5});
  sky.material.uniforms.rayleigh.value = 1.35;
  sky.material.uniforms.mieCoefficient.value = .0035;
  sky.material.uniforms.mieDirectionalG.value = .86;
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  const skyScene = new T.Scene(); skyScene.add(sky);
  const cubeRT = new T.WebGLCubeRenderTarget(512, {type:T.HalfFloatType, generateMipmaps:true, minFilter:T.LinearMipmapLinearFilter});
  new T.CubeCamera(1, 20000, cubeRT).update(renderer, skyScene);
  scene.background = cubeRT.texture; scene.backgroundIntensity = .34;
  if (W.skyDome) W.skyDome.visible = false;
  scene.fog = new T.FogExp2(0xc6d6e2, .00042);

  /* ---------- Painted cumulus sprites (fbm noise, lit tops, shaded bases) ---------- */
  // Each cloud is built from dozens of soft puffs, then shaded darker toward a flat base.
  const cloudTex = k => canvasTex(512, 256, (c, w, h) => {
    const puffs = 70 + k*10;
    for (let i = 0; i < puffs; i++) {
      const a = rnd(), x = 60 + rnd()*392, top = 40 + Math.pow(Math.abs(x - 256)/196, 1.6)*110;
      const y = top + rnd()*(190 - top), r = 22 + rnd()*48*(1 - Math.abs(x - 256)/300);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(.6, 'rgba(250,252,255,.22)'); g.addColorStop(1, 'rgba(250,252,255,0)');
      c.fillStyle = g; c.fillRect(x - r, y - r, r*2, r*2);
    }
    c.globalCompositeOperation = 'source-atop';
    const shade = c.createLinearGradient(0, 40, 0, 220); shade.addColorStop(0, 'rgba(255,255,255,0)'); shade.addColorStop(.55, 'rgba(214,222,232,.35)'); shade.addColorStop(1, 'rgba(150,164,182,.85)');
    c.fillStyle = shade; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out';
    const base = c.createLinearGradient(0, 196, 0, 230); base.addColorStop(0, 'rgba(0,0,0,0)'); base.addColorStop(1, 'rgba(0,0,0,1)');
    c.fillStyle = base; c.fillRect(0, 196, w, 60);
  });
  const cloudMats = [0, 1, 2, 3].map(k => new T.SpriteMaterial({map:cloudTex(k), transparent:true, depthWrite:false, fog:true, opacity:.92}));
  W.cumulus = [];
  for (let i = 0; i < 46; i++) {
    const a = rnd()*Math.PI*2, r = 500 + rnd()*1700;
    const s = new T.Sprite(cloudMats[i % 4]); const w = 260 + rnd()*380; s.scale.set(w, w*.5, 1);
    s.position.set(Math.cos(a)*r, 280 + rnd()*260, Math.sin(a)*r); s.userData.x0 = s.position.x; s.renderOrder = -1;
    D.add(s); W.cumulus.push(s);
  }
  (W.clouds || []).forEach(c => c.visible = false);

  /* ---------- Sun glare ---------- */
  const flareTex = (inner, outer, ring) => canvasTex(256, 256, (c, w) => { const g = c.createRadialGradient(w/2, w/2, 0, w/2, w/2, w/2); g.addColorStop(0, inner); if (ring) { g.addColorStop(.72, 'rgba(255,255,255,0)'); g.addColorStop(.86, ring); } g.addColorStop(1, outer); c.fillStyle = g; c.fillRect(0, 0, w, w); });
  const flare = new Lensflare();
  flare.addElement(new LensflareElement(flareTex('rgba(255,250,235,1)', 'rgba(255,240,210,0)'), 520, 0, new T.Color(1, .97, .9)));
  flare.addElement(new LensflareElement(flareTex('rgba(255,255,255,0)', 'rgba(255,255,255,0)', 'rgba(170,210,255,.35)'), 120, .5));
  flare.addElement(new LensflareElement(flareTex('rgba(255,220,170,.35)', 'rgba(255,220,170,0)'), 70, .7));
  flare.addElement(new LensflareElement(flareTex('rgba(160,200,255,.28)', 'rgba(160,200,255,0)'), 160, 1));
  scene.add(flare);

  /* ---------- Sharper shadows ---------- */
  sun.shadow.mapSize.set(2048, 2048); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  sun.intensity = 2.3;

  /* ---------- Ground: greener, patchwork farmland outside the fence ---------- */
  if (W.ground) {
    const g = W.ground.geometry, p = g.attributes.position, col = g.attributes.color;
    const crops = [[.22, .42, .40], [.25, .38, .34], [.13, .35, .52], [.17, .30, .45], [.28, .30, .30], [.10, .25, .55]];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), inside = Math.abs(x) < 540 && Math.abs(z) < 250;
      let h = .24, s = .34, l = .42 + .03*Math.sin(x*.05)*Math.cos(z*.04);
      if (!inside) {
        const u = x*.94 + z*.34, v = z*.94 - x*.34, cx = Math.floor(u/190), cz = Math.floor(v/130);
        const k = Math.abs((cx*73856093) ^ (cz*19349663)) % crops.length; [h, s, l] = crops[k];
        const edge = Math.min(Math.abs(u/190 - Math.round(u/190)), Math.abs(v/130 - Math.round(v/130)));
        if (edge < .035) { h = .27; s = .4; l = .25; }
      }
      const c = new T.Color().setHSL(h, s, l); col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true; W.ground.material.color.setHex(0xffffff); W.ground.material.needsUpdate = true;
  }

  /* ---------- Fix oversized edge lights: small glass domes ---------- */
  if (W.edgeLights) { W.edgeLights.geometry.dispose(); W.edgeLights.geometry = new T.SphereGeometry(.24, 10, 6, 0, Math.PI*2, 0, Math.PI/2); W.edgeLights.material = new T.MeshBasicMaterial({color:0xfff3cf}); W.edgeLights.position.y = -.35; }
  scene.traverse(o => { if (o.isMesh && o.geometry?.type === 'SphereGeometry' && o.geometry.parameters.radius === .6 && Math.abs(Math.abs(o.position.x) - 421) < 1) o.scale.setScalar(.45); });

  /* ---------- Wind-swept grass near every close-up camera ---------- */
  const bladeTex = canvasTex(128, 128, (c, w, h) => { for (let i = 0; i < 26; i++) { const x = 8 + rnd()*112, top = 10 + rnd()*60, bend = (rnd() - .5)*30; c.strokeStyle = `hsl(${78 + rnd()*20},${35 + rnd()*20}%,${28 + rnd()*22}%)`; c.lineWidth = 2 + rnd()*2.5; c.beginPath(); c.moveTo(x, h); c.quadraticCurveTo(x + bend*.3, (h + top)/2, x + bend, top); c.stroke(); } });
  const tuftGeo = (() => { const a = new T.PlaneGeometry(1.6, 1.1); a.translate(0, .55, 0); const b = a.clone(); b.rotateY(Math.PI/2); const geos = [a, b]; const pos = [], uv = [], idx = []; let off = 0; geos.forEach(gg => { pos.push(...gg.attributes.position.array); uv.push(...gg.attributes.uv.array); idx.push(...Array.from(gg.index.array, v => v + off)); off += gg.attributes.position.count; }); const m = new T.BufferGeometry(); m.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); m.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); m.setIndex(idx); m.computeVertexNormals(); return m; })();
  const grassMat = new T.MeshStandardMaterial({map:bladeTex, alphaTest:.45, side:T.DoubleSide, roughness:1});
  const windU = {value:0};
  grassMat.onBeforeCompile = sh => { sh.uniforms.uWind = windU; sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvec4 ip = instanceMatrix[3];\ntransformed.x += sin(uWind*1.9 + ip.x*.21 + ip.z*.13) * uv.y * .22;\ntransformed.z += cos(uWind*1.4 + ip.x*.17) * uv.y * .1;'); };
  const patches = [[130, -30, 70, 3200], [-370, 22, 90, 2600], [-370, -22, 80, 1600], [60, 30, 120, 2000], [200, -110, 60, 900]];
  const totalTufts = patches.reduce((s, p) => s + p[3], 0);
  const tufts = new T.InstancedMesh(tuftGeo, grassMat, totalTufts); const dm = new T.Object3D(); let ti = 0;
  patches.forEach(([cx, cz, r, n]) => { for (let i = 0; i < n; i++) { const a = rnd()*Math.PI*2, d = Math.sqrt(rnd())*r, x = cx + Math.cos(a)*d, z = cz + Math.sin(a)*d; if (Math.abs(z) < 23.5 || (Math.abs(z + 62) < 9.5 && Math.abs(x) < 372) || (z < -88 && z > -162 && Math.abs(x) < 172)) continue; dm.position.set(x, 0, z); const s = .28 + rnd()*.34; dm.scale.set(s, s*(.6 + rnd()*.6), s); dm.rotation.set(0, rnd()*6.28, 0); dm.updateMatrix(); tufts.setMatrixAt(ti, dm.matrix); tufts.setColorAt(ti++, new T.Color().setHSL(.18 + rnd()*.06, .22 + rnd()*.14, .36 + rnd()*.16)); } });
  tufts.count = ti; tufts.receiveShadow = true; D.add(tufts);

  /* ---------- Navigation aids ---------- */
  // PAPI: four units left of runway 10's aiming point, two red / two white as seen on a correct glide path.
  for (let k = 0; k < 4; k++) {
    const x = -300, z = 27 + k*3.2, g = new T.Group(); g.position.set(x, 0, z); D.add(g);
    B(1.6, .9, 1, std(0xe7e6df), 0, .9, 0, g); rod([-.5, 0, -.3], [-.5, .5, -.3], .06, metal, g); rod([.5, 0, .3], [.5, .5, .3], .06, metal, g);
    for (const dz of [-.25, .25]) { const lens = C(.18, .1, new T.MeshBasicMaterial({color:k < 2 ? 0xff3a2a : 0xfff4dc}), -.82, .95, dz, g, .18, 12); lens.rotation.z = Math.PI/2; }
    B(1.7, .1, 1.1, dark, 0, .05, 0, g);
  }
  // ILS localizer array beyond the far end of runway 10.
  const loc = new T.Group(); loc.position.set(470, 0, 0); D.add(loc);
  B(1, .8, 34, std(0xd9d9d2), 0, .4, 0, loc);
  for (let z = -15; z <= 15; z += 2.5) { rod([0, .8, z], [0, 3.6, z], .07, metal, loc); for (let j = 0; j < 4; j++) rod([-.9 + j*.08, 2.4 + j*.3, z], [.9 - j*.08, 2.4 + j*.3, z], .03, metal, loc); }
  rod([0, 3.6, -15.5], [0, 3.6, 15.5], .05, metal, loc);
  for (const z of [-17, 17]) add(new T.SphereGeometry(.22, 8, 6), new T.MeshBasicMaterial({color:0xff2a1a}), 0, 3.8, z, loc, false);
  B(4, 3, 3, std(0xe2e2da), -8, 1.5, 22, loc);
  // Glideslope mast beside the touchdown zone.
  const gs = new T.Group(); gs.position.set(-290, 0, -48); D.add(gs);
  C(.35, 18, std(0xdedfda), 0, 9, 0, gs, .5);
  for (const y of [9, 13.5]) B(1.2, 1.8, .5, std(0xe9e9e2), 0, y, -.6, gs);
  for (let y = 0; y < 18; y += 3) B(.9, .15, .9, std(0xe2541f), 0, y + 1.5, 0, gs);
  add(new T.SphereGeometry(.25, 8, 6), new T.MeshBasicMaterial({color:0xff2a1a}), 0, 18.3, 0, gs, false);
  B(3, 2.4, 2.4, std(0xe2e2da), 3, 1.2, 0, gs);
  // Distance-remaining boards along the south side.
  for (let k = 1; k <= 7; k++) { const x = 400 - k*100, g = new T.Group(); g.position.set(x, 0, 30); D.add(g); B(2.4, 2.2, .3, dark, 0, 1.6, 0, g); const f = new T.Mesh(new T.PlaneGeometry(2.2, 2), label(String(k), '#111', '#fff')); f.position.set(0, 1.6, .16); g.add(f); const b = f.clone(); b.rotation.y = Math.PI; b.position.z = -.16; g.add(b); rod([-.8, 0, 0], [-.8, .5, 0], .08, metal, g); rod([.8, 0, 0], [.8, .5, 0], .08, metal, g); }
  // Rotating airport beacon on a lattice tower behind the hangars.
  const bt = new T.Group(); bt.position.set(270, 0, -205); D.add(bt);
  for (const [x, z] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) rod([x, 0, z], [x*.35, 24, z*.35], .12, metal, bt);
  for (let y = 3; y < 24; y += 3) { const s = 1.4 - (y/24)*.9; [[-s, -s, s, -s], [s, -s, s, s], [s, s, -s, s], [-s, s, -s, -s]].forEach(([a, b, c, d]) => rod([a, y, b], [c, y, d], .05, metal, bt)); }
  B(2.4, .3, 2.4, dark, 0, 24.2, 0, bt);
  W.beaconHead = new T.Group(); W.beaconHead.position.y = 25.2; bt.add(W.beaconHead);
  C(.7, 1.6, std(0x30383e), 0, 0, 0, W.beaconHead);
  const beamGeo = new T.ConeGeometry(2.2, 26, 16, 1, true); beamGeo.translate(0, -13, 0); beamGeo.rotateZ(Math.PI/2);
  [[0x8dff9d, 0], [0xffffff, Math.PI]].forEach(([c, r]) => { const m = new T.Mesh(beamGeo, new T.MeshBasicMaterial({color:c, transparent:true, opacity:.035, blending:T.AdditiveBlending, depthWrite:false, side:T.DoubleSide})); m.rotation.y = r; W.beaconHead.add(m); add(new T.SphereGeometry(.45, 10, 8), new T.MeshBasicMaterial({color:c}), Math.cos(r)*.7, 0, -Math.sin(r)*.7, W.beaconHead, false); });

  /* ---------- Power line along the perimeter road ---------- */
  const poleMat = std(0x6b5440, {roughness:1}), wireMat = new T.LineBasicMaterial({color:0x2b2f33, transparent:true, opacity:.75});
  const poles = []; for (let x = -560; x <= 560; x += 56) poles.push(x);
  poles.forEach(x => { C(.32, 16, poleMat, x, 8, -246, D, .4, 8); B(5, .3, .3, poleMat, x, 15, -246); for (const dx of [-2.2, 0, 2.2]) C(.12, .5, std(0x9fb6c4, {roughness:.3}), x + dx, 15.4, -246, D, .12, 6); });
  for (let i = 0; i < poles.length - 1; i++) for (const dx of [-2.2, 0, 2.2]) { const pts = []; for (let j = 0; j <= 16; j++) { const s = j/16; pts.push(new T.Vector3(poles[i] + (poles[i + 1] - poles[i])*s + dx*0, 15.6 - Math.sin(s*Math.PI)*1.6, -246 + dx*.12)); } const l = new T.Line(new T.BufferGeometry().setFromPoints(pts), wireMat); l.position.x = dx; D.add(l); }

  /* ---------- Countryside: farmsteads, barns, silos and a village ---------- */
  const houseWall = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), std(0xe8e2d4), 260);
  const roofGeo = new T.CylinderGeometry(.72, .72, 1, 3, 1); roofGeo.rotateZ(Math.PI/2); roofGeo.rotateX(-Math.PI/2); roofGeo.rotateY(Math.PI/2);
  const roofs = new T.InstancedMesh(roofGeo, std(0x5b4b45, {roughness:.9}), 260);
  houseWall.castShadow = roofs.castShadow = true; houseWall.receiveShadow = roofs.receiveShadow = true;
  let hi = 0; const wallCols = [0xe8e2d4, 0xd9cdb6, 0xc9d1d4, 0xf0ece4, 0xb9a48a], roofCols = [0x5b4b45, 0x3e4549, 0x7a4a3a, 0x4d5257];
  const house = (x, z, w, d, h, rot) => { if (hi >= 260) return; const y = heightAt(x, z); dm.position.set(x, y + h/2 - .3, z); dm.rotation.set(0, rot, 0); dm.scale.set(w, h, d); dm.updateMatrix(); houseWall.setMatrixAt(hi, dm.matrix); houseWall.setColorAt(hi, new T.Color(wallCols[hi % 5])); dm.position.y = y + h - .3 + w*.15; dm.scale.set(w*.9, w*.4, d*1.08); dm.updateMatrix(); roofs.setMatrixAt(hi, dm.matrix); roofs.setColorAt(hi++, new T.Color(roofCols[hi % 4])); };
  // Village to the north-east.
  for (let i = 0; i < 120; i++) { const x = 700 + rnd()*420, z = -480 - rnd()*380; house(x, z, 8 + rnd()*6, 10 + rnd()*8, 6 + rnd()*4, Math.round(rnd()*4)*Math.PI/2 + (rnd() - .5)*.2); }
  // Scattered farmsteads with barns and silos.
  const barnMat = std(0x8a3326, {roughness:.85}), siloMat = std(0xb8bfc2, {metalness:.5, roughness:.45});
  for (let f = 0; f < 22; f++) {
    const a = rnd()*Math.PI*2, r = 650 + rnd()*900, x = Math.cos(a)*r, z = Math.sin(a)*r*.8; if (Math.abs(x) < 600 && Math.abs(z) < 320) continue;
    const y = heightAt(x, z), rot = rnd()*Math.PI;
    house(x, z, 9, 12, 7, rot);
    const bx = x + Math.cos(rot)*26, bz = z - Math.sin(rot)*26, by = heightAt(bx, bz);
    const barn = B(18, 11, 30, barnMat, bx, by + 5.2, bz); barn.rotation.y = rot;
    const br = add(roofGeo, std(0x4a4f52), bx, by + 13.9, bz); br.scale.set(18*.86, 9, 30*1.04); br.rotation.y = rot;
    for (let s = 0; s < 1 + (f % 2); s++) { const sx = bx + Math.cos(rot + 1.2)*(18 + s*9), sz = bz - Math.sin(rot + 1.2)*(18 + s*9), sy = heightAt(sx, sz); C(4, 26, siloMat, sx, sy + 13, sz, D, 4, 16); add(new T.SphereGeometry(4, 16, 8, 0, Math.PI*2, 0, Math.PI/2), siloMat, sx, sy + 26, sz); }
  }
  houseWall.count = roofs.count = hi; D.add(houseWall, roofs);
  // Distant water tower on the ridge.
  { const x = 980, z = -760, y = heightAt(x, z); for (const [dx, dz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) rod([x + dx*1.3, y, z + dz*1.3], [x + dx*.6, y + 34, z + dz*.6], .45); add(new T.SphereGeometry(10, 20, 14), std(0xdfe4e6, {metalness:.3, roughness:.4}), x, y + 42, z); }

  /* ---------- Particles: tyre dust on the takeoff roll, drifting pollen in close-ups ---------- */
  const softTex = canvasTex(64, 64, (c, w) => { const g = c.createRadialGradient(w/2, w/2, 0, w/2, w/2, w/2); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.4, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); });
  const pointMat = (color, additive) => new T.ShaderMaterial({
    uniforms:{map:{value:softTex}, color:{value:new T.Color(color)}, scale:{value:600}},
    vertexShader:'attribute float aSize; attribute float aAlpha; varying float vA; uniform float scale; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize*scale/max(1.0,-mv.z); vA = aAlpha; gl_Position = projectionMatrix*mv; }',
    fragmentShader:'uniform sampler2D map; uniform vec3 color; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(color, t.a*vA); }',
    transparent:true, depthWrite:false, blending:additive ? T.AdditiveBlending : T.NormalBlending
  });
  const makePoints = (n, mat) => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(n*3), 3)); g.setAttribute('aSize', new T.Float32BufferAttribute(new Float32Array(n), 1)); g.setAttribute('aAlpha', new T.Float32BufferAttribute(new Float32Array(n), 1)); const p = new T.Points(g, mat); p.frustumCulled = false; D.add(p); return p; };
  const dustMat = pointMat(0xcfc6b4, false), dust = makePoints(220, dustMat);
  const pollenMat = pointMat(0xfff6dc, true), pollen = makePoints(160, pollenMat);
  const pollenSeed = Array.from({length:160}, () => [rnd() - .5, rnd(), rnd() - .5, rnd()*6.28]);
  const jit = Array.from({length:220}, () => [rnd() - .5, rnd(), rnd() - .5]);
  function updateDust(id, gt) {
    const pos = dust.geometry.attributes.position, size = dust.geometry.attributes.aSize, al = dust.geometry.attributes.aAlpha;
    const u = W.planeU ?? -1, ur = Math.sqrt(2*280/7), on = (id === 's2' || id === 's8') && u > 2;
    for (let k = 0; k < 110; k++) for (let s = 0; s < 2; s++) {
      const i = k*2 + s, uk = Math.floor(u/.03)*.03 - k*.03, age = u - uk;
      if (!on || uk < 2 || uk > ur + .2 || age > 3.2) { al.setX(i, 0); continue; }
      const st = W.planeAt(uk), j = jit[i];
      pos.setXYZ(i, st.x - 4 + j[0]*3 - age*6, .5 + age*(1.2 + j[1]*1.4), (s ? 3.4 : -3.4) + (s ? 1 : -1)*age*(1.6 + j[2]*2));
      size.setX(i, .9 + age*2.4); al.setX(i, Math.max(0, .13*(1 - age/3.2))*Math.min(1, (uk - 2)/2));
    }
    pos.needsUpdate = size.needsUpdate = al.needsUpdate = true;
  }
  function updatePollen(id, gt) {
    const show = id === 's3' || id === 's5' || id === 's1';
    pollen.visible = show; if (!show) return;
    const pos = pollen.geometry.attributes.position, size = pollen.geometry.attributes.aSize, al = pollen.geometry.attributes.aAlpha;
    const c = camera.position, f = new T.Vector3(); camera.getWorldDirection(f);
    pollenSeed.forEach(([a, b, d, ph], i) => {
      const dist = 6 + b*40, x = c.x + f.x*dist + a*50 + Math.sin(gt*.3 + ph)*2, y = c.y + f.y*dist + (b - .5)*20 + Math.sin(gt*.5 + ph)*1.4, z = c.z + f.z*dist + d*50 + Math.cos(gt*.27 + ph)*2;
      pos.setXYZ(i, x, Math.max(.4, y), z); size.setX(i, .09 + (i % 5)*.03); al.setX(i, .55*(.5 + .5*Math.sin(gt*1.3 + ph)));
    });
    pos.needsUpdate = size.needsUpdate = al.needsUpdate = true;
  }

  /* ---------- Aircraft lighting: landing lights and navigation glow ---------- */
  const glowTex = softTex;
  const glow = (color, size, x, y, z, parent) => { const s = new T.Sprite(new T.SpriteMaterial({map:glowTex, color, transparent:true, depthWrite:false, blending:T.AdditiveBlending})); s.scale.setScalar(size); s.position.set(x, y, z); parent.add(s); return s; };
  if (W.plane) {
    W.landing = [glow(0xfff4dc, 1.3, 13.5, -3.6, 0, W.plane)];
    W.strobeGlow = glow(0xffffff, 1.6, -16, 3.5, 0, W.plane);
  }

  /* ---------- Post-processing chain ---------- */
  const pr = Math.min(1.15, window.devicePixelRatio || 1);
  const composer = new EffectComposer(renderer); composer.setPixelRatio(pr);
  const size = new T.Vector2(); renderer.getSize(size);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, size.x, size.y); gtao.blendIntensity = .8;
  gtao.updateGtaoMaterial({radius:2.2, distanceExponent:1.4, thickness:2.5, scale:1, samples:12});
  gtao.enabled = false; composer.addPass(gtao);
  // AO is computed from solid geometry only; see-through sprites, grass cards and wires are hidden for its depth/normal pass.
  const gtaoRender = gtao.render.bind(gtao);
  gtao.render = (...args) => {
    const hidden = [];
    scene.traverseVisible(o => { const m = o.material; if (o.isSprite || o.isPoints || o.isLine || o === flare || o.userData.noAO || (m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0))) hidden.push(o); });
    hidden.forEach(o => o.visible = false); gtaoRender(...args); hidden.forEach(o => o.visible = true);
  };
  const bloom = new UnrealBloomPass(new T.Vector2(size.x, size.y), .18, .5, .94); composer.addPass(bloom);
  const bokeh = new BokehPass(scene, camera, {focus:60, aperture:.00012, maxblur:.006}); bokeh.enabled = false; composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms:{tDiffuse:{value:null}, uTime:{value:0}, uVig:{value:.32}, uGrain:{value:.035}, uCA:{value:.0016}},
    vertexShader:'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:`uniform sampler2D tDiffuse; uniform float uTime, uVig, uGrain, uCA; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      void main(){
        vec2 d = vUv - .5; float r = dot(d, d);
        vec3 c = vec3(texture2D(tDiffuse, vUv + d*uCA*r*4.).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d*uCA*r*4.).b);
        float l = dot(c, vec3(.2126,.7152,.0722));
        c = mix(vec3(l), c, 1.06);
        c += vec3(-.012,.004,.02)*(1.-l) + vec3(.02,.008,-.016)*l;
        c = mix(c, c*c*(3.-2.*c), .18);
        c *= 1. - uVig*smoothstep(.12,.75,r*1.6);
        c += (h(vUv*vec2(1920.,1080.) + fract(uTime)*91.7) - .5)*uGrain;
        gl_FragColor = vec4(clamp(c,0.,1.), 1.);
      }`
  });
  composer.addPass(grade);
  const smaa = new SMAAPass(); composer.addPass(smaa);

  // Focus subject per shot; null keeps everything sharp.
  const focusOn = {s1: () => W.plane.position, s3: t => t > 5.5 ? W.anchors.phone : null, s5: () => W.anchors.phone, s8: t => t > 4.4 ? W.plane.position : null};
  const apertures = {s1:.00007, s3:.00016, s5:.00022, s8:.00006};
  let slowFrames = 0, frames = 0, lastT = performance.now(), quality = 0, windowStart = performance.now();
  const qualityRatio = () => quality === 0 ? pr : quality === -1 ? Math.min(pr, .9) : quality === -2 ? .75 : .6;

  W.cinemaUpdate = (id, t, gt) => {
    windU.value = gt;
    updateDust(id, gt); updatePollen(id, gt);
    W.cumulus.forEach((c, k) => c.position.x = c.userData.x0 + (gt*(1.5 + k % 3)) % 300);
    if (W.beaconHead) W.beaconHead.rotation.y = gt*2.1;
    flare.position.copy(camera.position).addScaledVector(sunDir, 4000);
    if (W.landing) { const on = W.plane.position.y < 40; W.landing.forEach(s => s.visible = on); }
    if (W.strobeGlow) W.strobeGlow.visible = W.plane.userData.strobe?.visible ?? false;
    // Subtle handheld breathing on live-action style shots.
    if (id !== 's6' && id !== 's7') { camera.rotateX(Math.sin(gt*.9)*.0012 + Math.sin(gt*2.3)*.0004); camera.rotateY(Math.cos(gt*.7)*.0012); }
    const f = focusOn[id] && focusOn[id](t);
    bokeh.enabled = false; // Avoid a second full scene/depth render on every frame.
    if (f) { bokeh.uniforms.focus.value = camera.position.distanceTo(f); bokeh.uniforms.aperture.value = apertures[id]; }
  };

  return {
    render(id, t, gt) {
      grade.uniforms.uTime.value = gt;
      composer.render();
      // Adaptive quality: reduce resolution, then costly screen effects on slow machines.
      const now = performance.now(), dt = now - lastT; lastT = now; frames++;
      // Steps down faster (anything under ~36 fps counts as slow) and one level further than before.
      if (dt > 28) slowFrames++;
      // Judge every ~1.2 s of wall time (not every N frames), so a slow machine adapts within seconds.
      if (now - windowStart > 1200 && frames >= 4) { windowStart = now; if (slowFrames > frames * 0.4 && quality > -3) { quality--; composer.setPixelRatio(qualityRatio()); if(quality <= -2){bloom.enabled=false;smaa.enabled=false;} } frames = slowFrames = 0; }
    },
    resize(w, h) { composer.setPixelRatio(Math.min(qualityRatio(), Math.sqrt(1400000 / Math.max(1, w*h)))); composer.setSize(w, h); }
  };
}
