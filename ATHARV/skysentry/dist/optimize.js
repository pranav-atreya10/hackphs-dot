import { mergeGeometries } from './vendor/utils/BufferGeometryUtils.js';

// Consolidate static surfaces without flattening moving parts or shader-driven foliage.
export function optimizeScene({T,scene,W}) {
  const dynamic=new Set([W.plane,W.drone,W.radar,W.risk,W.data,W.sock,W.beacon,W.serviceVehicle,W.beaconHead,W.anemo,W.vane,...(W.birds||[]),...(W.clouds||[])]);
  function batch(root,skip=new Set()) {
    root.updateWorldMatrix(true,true);
    const inverse=new T.Matrix4().copy(root.matrixWorld).invert(), buckets=new Map();
    root.traverseVisible(o=>{
      if(!o.isMesh||o.isInstancedMesh||o.isSkinnedMesh||Array.isArray(o.material)||o.material.transparent||o.material.transmission>0||o.material.userData?.windPatched)return;
      if(o===W.ground||o===W.skyDome)return;
      for(let p=o;p&&p!==root;p=p.parent)if(skip.has(p))return;
      const geo=o.geometry;
      if(geo.morphAttributes?.position?.length)return;
      const attrs=Object.keys(geo.attributes).sort().map(k=>k+':'+geo.attributes[k].itemSize).join(',');
      const key=[o.material.uuid,attrs,!!geo.index,o.castShadow,o.receiveShadow,o.renderOrder].join('|');
      if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(o);
    });
    for(const items of buckets.values()){
      if(items.length<2)continue;
      const geometries=items.map(o=>{const g=o.geometry.clone();g.applyMatrix4(new T.Matrix4().multiplyMatrices(inverse,o.matrixWorld));return g;});
      const combined=mergeGeometries(geometries);
      geometries.forEach(g=>g.dispose());
      if(!combined)continue;
      const mesh=new T.Mesh(combined,items[0].material);mesh.castShadow=items[0].castShadow;mesh.receiveShadow=items[0].receiveShadow;mesh.renderOrder=items[0].renderOrder;mesh.name='Batched static detail';
      items.forEach(o=>o.removeFromParent());root.add(mesh);
    }
  }
  batch(scene,dynamic);
  batch(W.plane,new Set([W.plane.userData.gear,...(W.fans||[]),W.plane.userData.strobe,W.planeBeacon]));
  for(const b of W.birds||[])batch(b,new Set([b.userData.wl,b.userData.wr]));
  // Stop using refraction buffers for tiny aircraft windows; retain their reflections and tint.
  scene.traverse(o=>{if(!o.isMesh)return;(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{if(m?.transmission>0){m.transmission=0;m.roughness=Math.max(.16,m.roughness);m.needsUpdate=true;}});});
  scene.updateMatrixWorld(true);
}
