// Nature pass: one shared wind field drives individual grass blades, trees, bushes,
// a flag and the windsock; moving cloud shadows dim direct sunlight on every lit surface.
// Runs after models.js.
export function enhanceNature({T, scene, W, rnd, camera}) {
  const time = {value:0};
  // Downwind direction matches the windsock and the drifting clouds.
  const windDir = new T.Vector3(Math.cos(.3), 0, -Math.sin(.3)).normalize();
  const uDir = {value:windDir};
  const GUST_GLSL = `
    uniform float uWindT; uniform vec3 uWindDir;
    float windGust(vec2 p){
      vec2 d = uWindDir.xz, n = vec2(-d.y, d.x);
      float a = sin(dot(p, d)*.035 - uWindT*1.8)*.5 + .5;
      float b = sin(dot(p, n)*.011 + uWindT*.4)*.5 + .5;
      float c = sin(dot(p, d)*.11 - uWindT*4.3 + dot(p, n)*.07)*.5 + .5;
      return clamp(a*b*.85 + c*.15, 0., 1.);
    }`;
  const gustJS = (x, z, t) => { const d = [windDir.x, windDir.z], n = [-d[1], d[0]]; const a = Math.sin((x*d[0] + z*d[1])*.035 - t*1.8)*.5 + .5, b = Math.sin((x*n[0] + z*n[1])*.011 + t*.4)*.5 + .5, c = Math.sin((x*d[0] + z*d[1])*.11 - t*4.3 + (x*n[0] + z*n[1])*.07)*.5 + .5; return Math.min(1, a*b*.85 + c*.15); };

  // Replace three's projection step so displacement happens in world space after instancing.
  const projectWith = displace => `
    vec4 mvPosition = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
    #endif
    mvPosition = modelMatrix * mvPosition;
    ${displace}
    mvPosition = viewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;`;
  const windPatch = (mat, key, vertexHead, displace, fragment) => {
    if (mat.userData.windPatched) return; mat.userData.windPatched = true;
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.onBeforeCompile = (sh, r) => {
      prev && prev.call(mat, sh, r);
      sh.uniforms.uWindT = time; sh.uniforms.uWindDir = uDir;
      sh.vertexShader = GUST_GLSL + '\n' + vertexHead + '\n' + sh.vertexShader.replace('#include <project_vertex>', projectWith(displace));
      if (fragment) fragment(sh);
    };
    mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|wind-' + key;
    mat.needsUpdate = true;
  };

  /* ---------- Grass blades ---------- */
  const bladeGeo = (() => {
    const seg = 3, pos = [], idx = [];
    for (let i = 0; i <= seg; i++) { const v = i/seg, w = .5*(1 - v*.92), bend = v*v*.22; pos.push(-w, v, bend, w, v, bend); }
    for (let i = 0; i < seg; i++) { const a = i*2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g.setAttribute('normal', new T.Float32BufferAttribute(pos.map((_, i) => i % 3 === 1 ? 1 : i % 3 === 2 ? .35 : 0), 3));
    return g;
  })();
  const bladeMat = new T.MeshStandardMaterial({color:0xffffff, roughness:.85, side:T.DoubleSide});
  windPatch(bladeMat, 'blade', 'varying float vBladeH;\n',
    `float h = position.y; vBladeH = h;
     float g = windGust(mvPosition.xz);
     float sway = sin(uWindT*2.6 + mvPosition.x*.37 + mvPosition.z*.29)*.08;
     float bend = (.18 + g*.62 + sway) * h*h;
     float len = length(instanceMatrix[1].xyz);
     mvPosition.xyz += uWindDir * bend * len;
     mvPosition.y -= bend*bend*len*.45;`,
    sh => {
      sh.fragmentShader = 'varying float vBladeH;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= mix(.32, 1.0, vBladeH);');
      sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n objectNormal = normalize(mix(objectNormal, vec3(0.,1.,0.), .35));');
    });
  const paved = (x, z) => Math.abs(z) < 23 || (Math.abs(z + 62) < 9.5 && Math.abs(x) < 372) || (Math.abs(x) < 9 && z < -16 && z > -62) || (Math.abs(x - 300) < 9 && z < -16 && z > -62) || (Math.abs(x + 300) < 9 && z < -16 && z > -62) || (z < -88 && z > -162 && Math.abs(x) < 172) || z < -165;
  const areas = [
    {c:[130, -30], r:58, n:10000},
    {rect:[-470, -290, 23, 75], n:5000}, {rect:[-470, -290, -75, -23], n:3500},
    {rect:[-400, 150, 23, 72], n:25000},
    {rect:[60, 200, -60, -23], n:3500}
  ];
  const total = areas.reduce((s, a) => s + a.n, 0);
  const blades = new T.InstancedMesh(bladeGeo, bladeMat, total), dm = new T.Object3D(), col = new T.Color(); let bi = 0;
  areas.forEach(a => { for (let i = 0; i < a.n; i++) {
    let x, z;
    if (a.c) { const ang = rnd()*6.283, d = Math.sqrt(rnd())*a.r; x = a.c[0] + Math.cos(ang)*d; z = a.c[1] + Math.sin(ang)*d; }
    else { x = a.rect[0] + rnd()*(a.rect[1] - a.rect[0]); z = a.rect[2] + rnd()*(a.rect[3] - a.rect[2]); }
    if (paved(x, z)) continue;
    const h = .45 + rnd()*.6 + (rnd() < .06 ? .5 : 0), w = .07 + rnd()*.06;
    dm.position.set(x, .02, z); dm.rotation.set((rnd() - .5)*.25, rnd()*6.283, (rnd() - .5)*.25); dm.scale.set(w, h, w*6); dm.updateMatrix();
    blades.setMatrixAt(bi, dm.matrix);
    const dry = rnd() < .07; col.setHSL(dry ? .12 + rnd()*.03 : .19 + rnd()*.07, dry ? .3 : .42 + rnd()*.2, dry ? .4 + rnd()*.08 : .22 + rnd()*.12);
    blades.setColorAt(bi++, col);
  } });
  blades.count = bi; blades.castShadow = false; blades.receiveShadow = true; blades.frustumCulled = false; blades.userData.noAO = true; blades.name = 'Grass blades';
  scene.add(blades);
  // The older billboard tufts are replaced by real blades.
  scene.traverse(o => { if (o.isInstancedMesh && o.material?.alphaTest === .45 && o.material.map) o.visible = false; });

  /* ---------- Trees and bushes sway ---------- */
  scene.traverse(o => {
    if (!o.isInstancedMesh || o === blades) return;
    const geoType = o.geometry?.type;
    if (geoType === 'IcosahedronGeometry' && o.count >= 1000) {          // tree crowns
      windPatch(o.material, 'crown', '', `float g = windGust(mvPosition.xz); float k = .55 + .45*position.y;
        mvPosition.xyz += uWindDir * (g*.9 + sin(uWindT*1.4 + mvPosition.x*.05 + mvPosition.z*.04)*.35) * k;
        mvPosition.y += sin(uWindT*3.1 + mvPosition.z*.2)*.06*k;`);
    } else if (geoType === 'SphereGeometry' && o.count >= 100) {         // round bushes
      windPatch(o.material, 'bush', '', `float g = windGust(mvPosition.xz); float k = clamp(position.y/4.5 + .5, 0., 1.);
        mvPosition.xyz += uWindDir * (g*.45 + sin(uWindT*1.9 + mvPosition.x*.08)*.15) * k;`);
    } else if (o.name === 'shrub_02' || o.name === 'shrub_04') {          // scanned shrubs
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => windPatch(m, 'shrub', '', `float g = windGust(mvPosition.xz); float k = clamp(position.y/2.2, 0., 1.); k *= k;
        mvPosition.xyz += uWindDir * (g*.7 + sin(uWindT*2.4 + mvPosition.x*.21 + mvPosition.z*.17)*.25) * k * length(instanceMatrix[1].xyz);`));
    }
  });

  /* ---------- Flag on the terminal forecourt ---------- */
  const flagTex = (() => { const c = document.createElement('canvas'); c.width = 380; c.height = 200; const x = c.getContext('2d');
    for (let i = 0; i < 13; i++) { x.fillStyle = i % 2 ? '#ffffff' : '#b22234'; x.fillRect(0, i*200/13, 380, 200/13 + 1); }
    x.fillStyle = '#3c3b6e'; x.fillRect(0, 0, 152, 200*7/13); x.fillStyle = '#fff';
    for (let r = 0; r < 9; r++) for (let k = 0; k < (r % 2 ? 5 : 6); k++) { x.beginPath(); x.arc(13 + k*25 + (r % 2 ? 12.5 : 0), 9 + r*11.6, 3.2, 0, 7); x.fill(); }
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8; return t; })();
  const flagMat = new T.MeshStandardMaterial({map:flagTex, side:T.DoubleSide, roughness:.8});
  windPatch(flagMat, 'flag', 'varying float vFold;\n', `float u = (position.x + 3.)/6.;
      float g = windGust(mvPosition.xz);
      float wave = sin(position.x*1.7 - uWindT*(6. + g*5.) + position.y*.6);
      vFold = wave;
      mvPosition.xyz += vec3(-uWindDir.z, 0., uWindDir.x) * wave * u * (.35 + g*.35);
      mvPosition.y -= u*u*(1. - g)*1.1;`,
    sh => { sh.fragmentShader = 'varying float vFold;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= .82 + .18*vFold;'); });
  const pole = new T.Group(); pole.position.set(96, 0, -160); scene.add(pole);
  const poleMesh = new T.Mesh(new T.CylinderGeometry(.09, .13, 15, 10), new T.MeshStandardMaterial({color:0xd8dcdf, metalness:.7, roughness:.3})); poleMesh.position.y = 7.5; poleMesh.castShadow = true; pole.add(poleMesh);
  const finial = new T.Mesh(new T.SphereGeometry(.2, 10, 8), new T.MeshStandardMaterial({color:0xd7b45a, metalness:.8, roughness:.3})); finial.position.y = 15.1; pole.add(finial);
  const flag = new T.Mesh(new T.PlaneGeometry(6, 3.2, 30, 12), flagMat); flag.position.set(3.1, 13.2, 0); flag.rotation.y = .3; flag.castShadow = true; pole.add(flag);
  pole.rotation.y = 0;

  /* ---------- Cloud shadows: dim direct sun on every lit material ---------- */
  const cloudT = {value:0};
  const CLOUD_GLSL = `
    uniform float uCloudT;
    float cnH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
    float cnN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3. - 2.*f); return mix(mix(cnH(i), cnH(i + vec2(1, 0)), f.x), mix(cnH(i + vec2(0, 1)), cnH(i + vec2(1, 1)), f.x), f.y); }
    float cloudShade(vec3 wp){ vec2 p = wp.xz*.0021 - uCloudT*vec2(.010, -.003); float n = cnN(p)*.55 + cnN(p*2.13)*.3 + cnN(p*4.37)*.15; return mix(1., .38, smoothstep(.56, .7, n)); }`;
  const seen = new Set();
  scene.traverse(o => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (!m || seen.has(m) || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return;
      seen.add(m);
      const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey?.bind(m);
      m.onBeforeCompile = (sh, r) => {
        prev && prev.call(m, sh, r);
        sh.uniforms.uCloudT = cloudT;
        sh.fragmentShader = CLOUD_GLSL + '\n' + sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          { vec3 cwp = transpose(mat3(viewMatrix)) * (-vViewPosition) + cameraPosition; float cs = cloudShade(cwp);
            reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }`);
      };
      m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|clouds';
      m.needsUpdate = true;
    });
  });

  /* ---------- Wind-driven updates ---------- */
  W.windGust = gustJS;
  W.natureUpdate = (id, t, gt) => {
    time.value = gt; cloudT.value = gt;
    blades.visible = !camera || camera.position.y < 95;
    if (W.sock) { const g = gustJS(380, -34, gt); W.sock.rotation.y = .3 + Math.sin(gt*1.7)*.05*g; W.sock.rotation.z = -(1 - g)*.42 + Math.sin(gt*7)*.03*g; }
  };
}
