import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { loadGltfJson } from './assetload.js';

// Model pass: places scanned CC0 props from Poly Haven around the airfield, and rebuilds
// the geese, parked light aircraft and tower roof in more detail. Runs after cinema.js.
export async function enhanceModels({T, scene, W, rnd}) {
  const D = new T.Group(); D.name = 'Scanned props and rebuilt models'; scene.add(D);
  const heightAt = (x, z) => { const d = Math.hypot(Math.max(0, Math.abs(x) - 540), Math.max(0, Math.abs(z) - 250)); const n = Math.sin(x*.004)*Math.cos(z*.005) + .5*Math.sin(x*.011 + z*.007); return d > 0 ? (n + 1.3)*Math.min(1, d/420)*34 : 0; };
  const materialCache = new Map();
  const std = (c,o) => {const key=JSON.stringify([c,o||{}]);if(!materialCache.has(key))materialCache.set(key,new T.MeshStandardMaterial(Object.assign({color:c,roughness:.75,metalness:0},o||{})));return materialCache.get(key);};
  const add = (geo, mat, x, y, z, p, cast = true) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; p.add(m); return m; };

  /* ---------- Scanned props, instanced per mesh ---------- */
  const loader = new GLTFLoader();
  const url = id => new URL(`./assets/models/${id}/${id}_smooth.gltf.json`, import.meta.url).href;
  // p: [x, z, rotationY, scale, y?]; y defaults to the terrain height.
  const place = {
    shrub_02: [], shrub_04: [], boulder_01: [], street_lamp_01: [], security_camera_01: [], utility_box_01: [],
    exterior_aircon_unit: [], concrete_road_barrier: [], portable_generator: [], small_lpg_tank: [], fire_hydrant: []
  };
  // Bushes along both fence lines and around buildings.
  for (let x = -540; x <= 540; x += 9 + rnd()*14) { place.shrub_02.push([x, -258 - rnd()*6, rnd()*6.3, .55 + rnd()*.6]); if (rnd() < .6) place.shrub_02.push([x + 4, 253 + rnd()*6, rnd()*6.3, .5 + rnd()*.6]); }
  [[60, -200], [150, -200], [200, -145], [180, -145], [75, -168], [146, -168]].forEach(([x, z]) => place.shrub_02.push([x, z, rnd()*6.3, .35 + rnd()*.2]));
  // Low ground plants where the camera gets close: the phone station, runway 10 threshold, the tower base.
  const scatter = (cx, cz, r, n, list, smin, smax, avoid) => { for (let i = 0; i < n; i++) { const a = rnd()*6.283, d = Math.sqrt(rnd())*r, x = cx + Math.cos(a)*d, z = cz + Math.sin(a)*d; if (avoid && avoid(x, z)) continue; list.push([x, z, rnd()*6.3, smin + rnd()*(smax - smin)]); } };
  const offPavement = (x, z) => Math.abs(z) < 24 || (Math.abs(z + 62) < 10 && Math.abs(x) < 372) || (z < -88 && z > -162 && Math.abs(x) < 172);
  scatter(130, -30, 30, 110, place.shrub_04, 1.2, 2.6, offPavement);
  scatter(-380, 30, 45, 90, place.shrub_04, 1.2, 2.4, offPavement);
  scatter(-380, -30, 45, 70, place.shrub_04, 1.2, 2.4, offPavement);
  scatter(200, -112, 18, 30, place.shrub_04, 1, 2, offPavement);
  // Boulders on the field edges and outside the fence.
  for (let i = 0; i < 34; i++) { const a = rnd()*6.283, r = 560 + rnd()*500, x = Math.cos(a)*r, z = Math.sin(a)*r*.75; place.boulder_01.push([x, z, rnd()*6.3, 1.2 + rnd()*2.2]); }
  [[-470, -128], [-452, -168], [-488, -176], [100, -46], [158, -18]].forEach(([x, z]) => place.boulder_01.push([x, z, rnd()*6.3, .6 + rnd()*.5]));
  // Apron and car-park floodlights, scaled up to apron-mast height.
  for (let x = -150; x <= 150; x += 60) place.street_lamp_01.push([x, -91, Math.PI/2, 2.3, 0]);
  for (let x = 35; x <= 205; x += 42) place.street_lamp_01.push([x, -222, 0, 1.6, 0]);
  // Security cameras on hangar and terminal corners.
  [-130, -60, 10].forEach(x => { place.security_camera_01.push([x - 21.5, -167.3, Math.PI, 1.6, 12.2]); place.security_camera_01.push([x + 21.5, -167.3, Math.PI, 1.6, 12.2]); });
  place.security_camera_01.push([75, -168.6, Math.PI, 1.6, 10.6], [145, -168.6, Math.PI, 1.6, 10.6]);
  // Electrical cabinets beside the tower, beacon, ILS shelter and camera station.
  [[201, -118, -Math.PI/2], [201, -121, -Math.PI/2], [262, -200, 0], [465, 24, Math.PI/2], [137, -34, .4], [-286, -52, 0]].forEach(([x, z, r]) => place.utility_box_01.push([x, z, r, 1.4, 0]));
  // Rooftop air-conditioning on the terminal, ground units by the hangars.
  for (let x = 82; x <= 138; x += 14) place.exterior_aircon_unit.push([x, -188, 0, 1.6, 12]);
  [-130, -60, 10].forEach(x => place.exterior_aircon_unit.push([x + 25.2, -192, Math.PI/2, 1.5, 0]));
  // Jersey barriers along the perimeter road and around the fuel island.
  for (let x = -40; x <= 210; x += 3.4) place.concrete_road_barrier.push([x, -244.5, 0, 1.1, 0]);
  for (let i = 0; i < 6; i++) place.concrete_road_barrier.push([-36 + i*3.4, -161.5, 0, 1.05, 0]);
  // Ground power units and LPG tanks.
  [[-112, -145, .3], [-70, -150, -.6], [42, -146, 1.1], [-150, -103, .2]].forEach(([x, z, r]) => place.portable_generator.push([x, z, r, 1.5, 0]));
  [-130, -60, 10].forEach(x => { place.small_lpg_tank.push([x - 25, -196, 0, 2, 0]); place.small_lpg_tank.push([x - 25, -199, 0, 2, 0]); });
  [[-104, -158], [58, -158], [-20, -92], [120, -205], [180, -205]].forEach(([x, z]) => place.fire_hydrant.push([x, z, rnd()*6.3, 1.3, 0]));

  const shadowless = new Set(['shrub_04']);
  const dm = new T.Object3D(), m4 = new T.Matrix4();
  const loads = Object.entries(place).map(([id, list]) => loadGltfJson(loader, url(id)).then(gltf => {
    const root = gltf.scene; root.updateMatrixWorld(true);
    const box = new T.Box3().setFromObject(root), lift = -box.min.y;
    root.traverse(o => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); geo.translate(0, lift, 0);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => { m.envMapIntensity = .9; if (m.map) m.map.anisotropy = 8; });
      const inst = new T.InstancedMesh(geo, o.material, list.length);
      list.forEach(([x, z, r, s, y], i) => { dm.position.set(x, y ?? heightAt(x, z), z); dm.rotation.set(0, r, 0); dm.scale.setScalar(s); dm.updateMatrix(); inst.setMatrixAt(i, dm.matrix); });
      inst.castShadow = !shadowless.has(id); inst.receiveShadow = true; inst.name = id;
      D.add(inst);
    });
  }));

  /* ---------- Canada geese, rebuilt ---------- */
  const brown = std(0x6f6355, {roughness:.95}), breast = std(0xb3a690, {roughness:.95}), blackM = std(0x1d2124, {roughness:.7}),
        whiteM = std(0xeeeae0, {roughness:.9}), primaries = std(0x3f382f, {roughness:.95, side:T.DoubleSide}), coverts = std(0x7d705f, {roughness:.95, side:T.DoubleSide});
  const lathe = (profile, sy = .85) => { const g = new T.LatheGeometry(profile.map(([r, y]) => new T.Vector2(r, y)), 14); g.rotateZ(-Math.PI/2); g.scale(1, sy, 1); return g; };
  const bodyGeo = lathe([[0, -1.15], [.12, -1.05], [.24, -.85], [.36, -.45], [.42, 0], [.4, .45], [.3, .78], [.14, .95], [0, 1]]);
  const neckGeo = new T.TubeGeometry(new T.CatmullRomCurve3([new T.Vector3(.8, .06, 0), new T.Vector3(1.3, .12, 0), new T.Vector3(1.85, .16, 0)]), 12, .09, 8);
  const headGeo = new T.SphereGeometry(.16, 12, 10); headGeo.scale(1.45, 1, .9);
  const beakGeo = new T.ConeGeometry(.06, .3, 8); beakGeo.rotateZ(-Math.PI/2);
  const chinGeo = new T.SphereGeometry(.11, 10, 8); chinGeo.scale(.9, .85, 1.35);
  const tailGeo = new T.SphereGeometry(.2, 10, 6); tailGeo.scale(1.3, .45, 1.1);
  const shape = pts => { const s = new T.Shape(); s.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => s.lineTo(p[0], p[1])); const g = new T.ShapeGeometry(s); g.rotateX(Math.PI/2); return g; };
  const innerGeo = shape([[.42, 0], [.36, 1.15], [-.3, 1.2], [-.55, 0]]);
  const outerGeo = shape([[.36, 0], [.18, .7], [0, 1.3], [-.12, 1.22], [-.18, 1.05], [-.26, .9], [-.3, .6], [-.3, 0]]);
  W.gooseOuter = [];
  W.birds.forEach(b => {
    b.children.forEach(c => { if (c !== b.userData.wl && c !== b.userData.wr) c.visible = false; });
    add(bodyGeo, brown, 0, 0, 0, b);
    const br = add(new T.SphereGeometry(.34, 12, 8), breast, .45, -.08, 0, b); br.scale.set(1.3, .8, .95);
    add(neckGeo, blackM, 0, 0, 0, b);
    add(headGeo, blackM, 2, .17, 0, b);
    add(beakGeo, blackM, 2.3, .14, 0, b);
    add(chinGeo, whiteM, 1.98, .11, 0, b);
    add(tailGeo, blackM, -1.08, .02, 0, b);
    const ut = add(new T.SphereGeometry(.14, 8, 6), whiteM, -.9, -.13, 0, b); ut.scale.set(1.5, .6, 1);
    [b.userData.wl, b.userData.wr].forEach((wing, k) => {
      wing.children.forEach(c => c.visible = false);
      const side = new T.Group(); side.scale.z = k ? -1 : 1; wing.add(side);
      add(innerGeo, coverts, 0, 0, .2, side, true);
      const outer = new T.Group(); outer.position.set(0, 0, 1.38); side.add(outer);
      add(outerGeo, primaries, 0, 0, 0, outer, true);
      W.gooseOuter.push({outer, wing, sign:k ? -1 : 1});
    });
  });

  /* ---------- Parked light aircraft (high-wing single engine) ---------- */
  const lightPlane = (body, trim) => {
    const g = new T.Group(), mb = std(body, {roughness:.35, metalness:.1}), mt = std(trim, {roughness:.4}), glass = new T.MeshPhysicalMaterial({color:0x2b4152, roughness:.08, metalness:.2, transparent:true, opacity:.85}), dark = std(0x24282c), tyre = std(0x141618, {roughness:.9});
    const fus = new T.LatheGeometry([[0, -4.6], [.18, -4.4], [.42, -2.4], [.62, -.4], [.66, .9], [.6, 1.9], [.44, 2.5], [0, 2.7]].map(([r, y]) => new T.Vector2(r, y)), 16);
    fus.rotateZ(-Math.PI/2); fus.scale(1, 1.25, .9); add(fus, mb, 0, 1.6, 0, g);
    add(new T.BoxGeometry(1.6, .65, 1.22), glass, .5, 2.25, 0, g);
    add(new T.BoxGeometry(1.4, .12, 11), mb, .2, 2.65, 0, g);
    for (const z of [-5.4, 5.4]) add(new T.BoxGeometry(1.42, .13, .3), mt, .2, 2.65, z, g);
    for (const z of [-1, 1]) { const st = add(new T.CylinderGeometry(.04, .04, 2.4, 6), dark, .3, 1.75, z*1.9, g); st.rotation.x = z*.75; }
    add(new T.BoxGeometry(1.1, 1.5, .1), mb, -4.1, 2.35, 0, g).rotation.z = .35;
    add(new T.BoxGeometry(.9, .08, 3.4), mb, -4.2, 1.75, 0, g);
    add(new T.BoxGeometry(5.6, .16, 1.34), mt, -.6, 1.55, 0, g);
    add(new T.SphereGeometry(.2, 12, 8), mt, 2.75, 1.6, 0, g).scale.set(1.6, 1, 1);
    const prop = new T.Group(); prop.position.set(3, 1.6, 0); g.add(prop); add(new T.BoxGeometry(.06, 1.9, .14), dark, 0, 0, 0, prop); prop.rotation.x = rnd()*3;
    [[2.1, 0], [-.2, .95], [-.2, -.95]].forEach(([x, z]) => { add(new T.CylinderGeometry(.04, .04, .7, 6), dark, x, .62, z, g); const w = add(new T.CylinderGeometry(.27, .27, .16, 14), tyre, x, .27, z, g); w.rotation.x = Math.PI/2; });
    for (const z of [-.95, .95]) { const fair = add(new T.SphereGeometry(.3, 10, 6), mb, -.2, .3, z, g); fair.scale.set(1.5, .7, .6); }
    return g;
  };
  const parked = []; scene.traverse(o => { if (o.isGroup && o.userData.gear && Math.abs(o.scale.x - .34) < .01) parked.push(o); });
  const liveries = [[0xf4f5f2, 0xc8332a], [0xf2f2ec, 0x1f5fa8], [0xf6f3e9, 0x1e6b4a]];
  parked.forEach((p, i) => { p.visible = false; const lp = lightPlane(...liveries[i % 3]); lp.position.set(p.position.x, 0, p.position.z); lp.rotation.y = p.rotation.y; D.add(lp); });
  // Wheel chocks and tie-down ropes beside each parked aircraft.
  parked.forEach(p => { for (const s of [-1, 1]) { const c = add(new T.BoxGeometry(.3, .2, .25), std(0xf2b705), p.position.x + s*1.2, .1, p.position.z, D); c.rotation.y = p.rotation.y; } });

  /* ---------- Tower roof: weather station and VHF antennas ---------- */
  const TW = [190, 0, -128], roof = new T.Group(); roof.position.set(TW[0], 66, TW[2]); D.add(roof);
  const steel = std(0x9aa3a8, {metalness:.7, roughness:.35});
  add(new T.CylinderGeometry(.08, .08, 4, 6), steel, 4, 2, 2, roof);
  W.anemo = new T.Group(); W.anemo.position.set(4, 4.1, 2); roof.add(W.anemo);
  for (let k = 0; k < 3; k++) { const a = k*2.094, arm = add(new T.BoxGeometry(.9, .04, .04), steel, Math.cos(a)*.45, 0, Math.sin(a)*.45, W.anemo); arm.rotation.y = -a; add(new T.SphereGeometry(.14, 8, 6, 0, Math.PI*2, 0, Math.PI/2), std(0x2a2e31), Math.cos(a)*.9, 0, Math.sin(a)*.9, W.anemo).rotation.z = Math.PI/2; }
  W.vane = new T.Group(); W.vane.position.set(4, 3.6, 2); roof.add(W.vane);
  add(new T.BoxGeometry(1.1, .04, .04), steel, 0, 0, 0, W.vane); add(new T.BoxGeometry(.04, .35, .3), steel, -.55, 0, 0, W.vane).rotation.y = Math.PI/2;
  for (const [x, z, h] of [[-5, -3, 6], [-3, 4, 5], [5, -4, 7]]) { add(new T.CylinderGeometry(.05, .07, h, 6), steel, x, h/2, z, roof); add(new T.SphereGeometry(.12, 8, 6), new T.MeshBasicMaterial({color:0xff2a1a}), x, h + .1, z, roof, false); }
  add(new T.BoxGeometry(1.6, .9, 1.2), std(0xdfe2de), -1, .45, -5, roof);

  await Promise.allSettled(loads).then(r => r.filter(x => x.status === 'rejected').forEach(x => console.warn('Model failed', x.reason)));

  W.modelsUpdate = (id, t, gt) => {
    // Outer wing lags the inner wing, so each beat bends at the wrist.
    W.gooseOuter.forEach(({outer, wing, sign}) => { outer.rotation.x = wing.rotation.x*.75*sign; });
    if (W.anemo) W.anemo.rotation.y = gt*5.5;
    if (W.vane) W.vane.rotation.y = .4 + Math.sin(gt*.6)*.15;
  };
}
