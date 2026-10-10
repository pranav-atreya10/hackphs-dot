import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { HDRLoader } from './vendor/loaders/HDRLoader.js';
import { mergeGeometries } from './vendor/utils/BufferGeometryUtils.js';
import { loadGltfJson, loadHdrJson } from './assetload.js';

// Additive scenery pass. The source film still owns its layout, shots and timeline.
export async function enhanceWorld({T,scene,renderer,W,ground,runwayMesh,taxiMesh,apronMesh,trees,bush,station,phone,TW,std,basic,mesh,box,rnd}) {
  const asset = name => new URL(`./assets/${name}`, import.meta.url).href;
  const pending = [];
  const D = new T.Group(); D.name='Airfield detail dressing'; scene.add(D);
  const load = new T.TextureLoader();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const metal = std(0x8c9397,{metalness:.75,roughness:.43});
  const dark = std(0x283238,{roughness:.6});
  const concrete = std(0xbbbbb0,{roughness:.94});
  const yellow = std(0xe9b622,{roughness:.7});
  const white = std(0xe1e3dc,{roughness:.63});
  const rubber = std(0x151b1e,{roughness:.88});
  const glass = new T.MeshPhysicalMaterial({color:0x537989,metalness:.2,roughness:.18,transparent:true,opacity:.73,envMapIntensity:1.15});
  const B=(w,h,d,m,x,y,z,p=D)=>box(w,h,d,m,x,y,z,p);
  const cyl=(r,h,m,x,y,z,p=D,r2=r)=>mesh(new T.CylinderGeometry(r,r2,h,12),m,x,y,z,p);
  function rod(a,b,r=.1,m=metal,p=D){const start=new T.Vector3(...a),end=new T.Vector3(...b),dir=end.clone().sub(start);const o=cyl(r,dir.length(),m,...start.clone().add(end).multiplyScalar(.5).toArray(),p);o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),dir.normalize());return o;}
  function plane(w,h,m,x,y,z,rx=0,ry=0,rz=0,p=D){const o=mesh(new T.PlaneGeometry(w,h),m,x,y,z,p,{noCast:true});o.rotation.set(rx,ry,rz);return o;}
  function canvasTexture(w,h,draw){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.anisotropy=maxAniso;return t;}
  function textMaterial(text,bg='#18232a',fg='#efc53c',size=64){const tex=canvasTexture(512,128,(c,w,h)=>{c.fillStyle=bg;c.fillRect(0,0,w,h);c.fillStyle=fg;c.font=`600 ${size}px Arial`;c.textAlign='center';c.textBaseline='middle';c.fillText(text,w/2,h/2+4);});return new T.MeshStandardMaterial({map:tex,roughness:.65});}
  function sign(text,x,z,angle=0,w=5){const g=new T.Group();g.position.set(x,0,z);g.rotation.y=angle;D.add(g);B(w,1.3,.22,dark,0,1.3,0,g);plane(w-.1,1.15,textMaterial(text),0,1.3,.12,0,0,0,g);rod([-w*.35,.1,0],[-w*.35,.7,0],.12,metal,g);rod([w*.35,.1,0],[w*.35,.7,0],.12,metal,g);return g;}

  // Real scanned ground surfaces and high dynamic range reflected daylight.
  pending.push(Promise.all([
    load.loadAsync(asset('clean_asphalt_diff_1k.jpg')),
    load.loadAsync(asset('clean_asphalt_nor_gl_1k.jpg')),
    load.loadAsync(asset('clean_asphalt_rough_1k.jpg')),
    load.loadAsync(asset('grass_ground_diff_1k.jpg')),
    loadHdrJson(T, HDRLoader, asset('derelict_airfield_01_1k.hdr.json'))
  ]).then(([diff,normal,rough,grass,hdr])=>{
    diff.colorSpace=grass.colorSpace=T.SRGBColorSpace;
    [diff,normal,rough,grass].forEach(t=>{t.wrapS=t.wrapT=T.RepeatWrapping;t.anisotropy=maxAniso;});
    grass.repeat.set(430,430);ground.material.color.setHex(0xa8bc87);ground.material.map=grass;ground.material.needsUpdate=true;
    const surface=(obj,x,z,tint=0xb2b4b5)=>{
      const maps=[diff,normal,rough].map(t=>{const n=t.clone();n.repeat.set(x/4,z/4);n.needsUpdate=true;return n;});
      const m=new T.MeshStandardMaterial({color:tint,map:maps[0],normalMap:maps[1],roughnessMap:maps[2],roughness:.97,normalScale:new T.Vector2(.42,.42)});
      const side=std(0x6b706b,{roughness:1});obj.material=[side,side,m,side,side,side];
    };
    surface(runwayMesh,840,32,0x7c8389);surface(taxiMesh,740,16,0x969b9e);surface(apronMesh,340,70,0xb4b4ad);
    hdr.mapping=T.EquirectangularReflectionMapping;
    const pmrem=new T.PMREMGenerator(renderer);W.environment=pmrem.fromEquirectangular(hdr);scene.environment=W.environment.texture;scene.environmentIntensity=.8;
    scene.environmentRotation.y=.55;
    W.clouds.forEach(c=>c.visible=false);pmrem.dispose();
  }));

  // Soft cloud banks, kept above the fictional horizon; HDR is used for lighting only.
  const cloudTexture=canvasTexture(512,256,(c,w,h)=>{
    for(let i=0;i<55;i++){const x=70+rnd()*370,y=95+(rnd()-.5)*80,r=25+rnd()*55;const gradient=c.createRadialGradient(x,y,0,x,y,r);gradient.addColorStop(0,'rgba(245,249,249,.18)');gradient.addColorStop(.55,'rgba(236,244,248,.1)');gradient.addColorStop(1,'rgba(234,242,247,0)');c.fillStyle=gradient;c.fillRect(x-r,y-r,r*2,r*2);}
  });
  const cloudMat=new T.MeshBasicMaterial({map:cloudTexture,transparent:true,depthWrite:false,opacity:.65,fog:true,side:T.DoubleSide});
  for(let i=0;i<12;i++){const a=i*Math.PI/6;const cloud=plane(380+rnd()*220,180,cloudMat,Math.cos(a)*1450,340+rnd()*130,Math.sin(a)*1450,0,-a+Math.PI/2);cloud.lookAt(0,200,0);}

  // Replace only the lead plane's coarse visual shell; preserve its parent animation.
  pending.push(loadGltfJson(new GLTFLoader(), asset('narrow-body-airliner.gltf.json')).then(gltf=>{
    const lead=W.plane, model=gltf.scene;
    model.name='Detailed airliner';model.scale.setScalar(1.15);model.position.y=-5.3;
    lead.children.forEach(c=>c.visible=false);lead.add(model);
    const retract=new T.Group();retract.position.y=4.1;model.add(retract);
    const parts=[];
    model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;if(o.material){o.material.envMapIntensity=.75;}if(/^(Main_(diagonal|oleo|seated_oleo|through_axle|torque|wheel)|Nose_(drag|fork|oleo|through|wheel))/.test(o.name))parts.push(o);}});
    model.updateMatrixWorld(true);parts.forEach(o=>retract.attach(o));lead.userData.gear=retract;
    const fanGroups=[];
    for(const side of ['1','-1']){
      const fanParts=[];model.traverse(o=>{if(o.isMesh&&o.name.startsWith('Turbofan_'+side+'_')&&(/fan_blade|tapered_fan_spinner|seated_rotating_shaft/.test(o.name)))fanParts.push(o);});
      if(fanParts.length){const bounds=new T.Box3();fanParts.forEach(o=>bounds.expandByObject(o));const center=bounds.getCenter(new T.Vector3());model.worldToLocal(center);const rotor=new T.Group();rotor.position.copy(center);model.add(rotor);model.updateMatrixWorld(true);fanParts.forEach(o=>rotor.attach(o));fanGroups.push(rotor);}
    }
    W.fans=fanGroups;
    const strobe=mesh(new T.SphereGeometry(.12,8,6),basic(0xffffff),-16,3.5,0,lead,{noCast:true});lead.userData.strobe=strobe;
    const beacon=mesh(new T.SphereGeometry(.10,8,6),basic(0xff4c24),-1,3.1,0,lead,{noCast:true});W.planeBeacon=beacon;
    // A narrow amber tail accent ties the sourced model to the existing SkySentry palette.
    W.realPlaneLoaded=true;
  }));

  // Rubber build-up, patch seams and aggregate are visible on the low runway shots.
  const wear=canvasTexture(2048,256,(c,w,h)=>{
    for(let i=0;i<340;i++){const y=h/2+(rnd()-.5)*h*.56,x=rnd()*w,len=30+rnd()*360;c.strokeStyle=`rgba(17,20,20,${.025+rnd()*.075})`;c.lineWidth=.4+rnd()*2.5;c.beginPath();c.moveTo(x,y);c.bezierCurveTo(x+len*.3,y+1,x+len*.7,y-1,x+len,y);c.stroke();}
    for(let i=0;i<70;i++){const x=rnd()*w,y=rnd()*h;c.strokeStyle='rgba(21,27,26,.24)';c.lineWidth=.5;c.beginPath();c.moveTo(x,y);for(let j=0;j<5;j++)c.lineTo(x+j*4+(rnd()-.5)*6,y+j*5);c.stroke();}
  });
  plane(670,26,new T.MeshBasicMaterial({map:wear,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}),-25,.508,0,-Math.PI/2);
  const patchMat=std(0x424a4b,{roughness:.95});
  for(let i=0;i<28;i++){const x=-360+rnd()*720,z=(rnd()-.5)*26;if(Math.abs(z)<2)continue;B(1+rnd()*4,.025,.7+rnd()*2,patchMat,x,.42,z);}
  // Drainage covers, inset approach lights and metal light housings.
  for(let x=-400;x<=400;x+=25){for(const z of [-17,17]){cyl(.42,.2,dark,x,.5,z);cyl(.18,.4,metal,x,.7,z);}}
  for(let x=-460;x>-560;x-=16){for(let z=-6;z<=6;z+=3){B(.38,.3,.3,metal,x,.2,z);mesh(new T.SphereGeometry(.22,8,6),basic(0xffebbb),x,.4,z,D,{noCast:true});}}
  for(let x=-280;x<=280;x+=80){for(const z of [-24,24]){B(2.2,.13,.8,dark,x,.12,z);for(let j=0;j<7;j++)B(.12,.03,.75,metal,x-.85+j*.28,.2,z);}}
  // Hold-short markings, taxi signs and apron parking guides.
  [-300,0,300].forEach((x,i)=>{
    for(let k=0;k<4;k++)for(let z=-35;z<-24;z+=1.5){B(.14,.025,k<2?1.5:.85,yellow,x-1+k*.55,.33,z);}
    sign(`${['A','B','C'][i]}  →`,x+15,-41,0,4.5);sign('10 — 28',x-14,-26,0,5);
  });
  sign('← A  |  APRON →',140,-82,0,8);sign('SKYSENTRY  ·  01',137,-36,Math.PI,5);
  [-150,-100,60].forEach((x,i)=>{
    B(.28,.04,37,yellow,x,.32,-124);B(15,.04,.25,yellow,x,.32,-113);
    plane(7,3,textMaterial(`0${i+1}`,'#555b5a','#e9c34c',80),x,.34,-100,-Math.PI/2);
    for(const z of [-116,-135]){B(1,.35,.5,yellow,x-3,.5,z);B(1,.35,.5,yellow,x+3,.5,z);}
  });

  // Ribbed hangars: door seams, glazing, rails, vents, gutters and apron fixtures.
  [-130,-60,10].forEach((x,i)=>{
    const sheet=std(i===1?0xaab5b8:0xc7c8bd,{metalness:.3,roughness:.62});
    for(let k=-22;k<=22;k+=2){B(.11,13.5,.13,sheet,x+k,7,-167.6);B(.13,13.5,.13,sheet,x+k,7,-204.2);}
    for(let k=-16;k<=16;k+=2.5){B(.14,13.5,.13,sheet,x-23.1,7,-186+k);B(.14,13.5,.13,sheet,x+23.1,7,-186+k);}
    for(let k=-15;k<=15;k+=4){B(.12,10.8,.15,metal,x+k,5.5,-167.3);B(3.4,1.8,.12,glass,x+k,8.7,-167.15);}
    B(34,.3,.4,metal,x,11.4,-167.25);B(34,.22,.4,metal,x,.35,-167.25);
    plane(14,2.4,textMaterial(`HANGAR 0${i+1}`,'#203547','#e8ece7',50),x,13.2,-167.05);
    for(const side of [-1,1]){rod([x+side*23,1,-168],[x+side*23,13,-168],.12,metal);B(1.1,.3,.5,dark,x+side*19,12,-167.2);B(.8,.15,.1,basic(0xfff0ce),x+side*19,11.85,-166.85);}
    for(let k=0;k<3;k++){cyl(.85,2.2,metal,x-12+k*12,35.8,-185);cyl(1.2,.3,dark,x-12+k*12,37,-185);}
  });
  // Terminal frontage with individual glazing, mullions and rooftop equipment.
  for(let x=77;x<146;x+=5){B(4.5,3.8,.12,glass,x,8,-168.65);B(.16,4.4,.3,dark,x-2.4,8,-168.4);}
  B(79,.7,6,white,110,6,-166);rod([76,0,-163],[76,6,-163],.18,metal);rod([145,0,-163],[145,6,-163],.18,metal);
  for(let i=0;i<3;i++){B(4.5,2.4,5,std(0x9ca5a6),94+i*13,13.2,-181);cyl(1.4,.3,dark,94+i*13,14.55,-181);}
  plane(34,2.2,textMaterial('SKYSENTRY  /  AIRFIELD','#d3d7cf','#263c49',32),110,11,-168.75);
  B(5,6,.12,glass,110,3,-168.5);B(.13,6,.25,metal,110,3,-168.3);

  // Weathered standing-seam roof panels and lightly mottled concrete.
  const roofTex=canvasTexture(512,512,(c,w,h)=>{c.fillStyle='#aab4b6';c.fillRect(0,0,w,h);for(let i=0;i<5000;i++){const n=Math.floor(140+rnd()*80);c.fillStyle=`rgba(${n},${n},${n},.10)`;c.fillRect(rnd()*w,rnd()*h,1+rnd()*3,1+rnd()*8);}for(let y=0;y<h;y+=32){c.fillStyle='#65777d';c.fillRect(0,y,w,2);c.fillStyle='#d2d9d8';c.fillRect(0,y+2,w,1);}});roofTex.wrapS=roofTex.wrapT=T.RepeatWrapping;roofTex.repeat.set(2,3);
  scene.children.filter(o=>o.geometry?.type==='CylinderGeometry'&&o.geometry.parameters.radiusTop===23).forEach(o=>{o.material=new T.MeshStandardMaterial({color:0xa5afb0,map:roofTex,metalness:.45,roughness:.6});});
  [-130,-60,10].forEach(x=>{for(let z=-203;z<-168;z+=4){const points=[];for(let j=0;j<=30;j++){const a=-Math.PI/2+j*Math.PI/30;points.push(new T.Vector3(x+Math.sin(a)*23.05,14+Math.cos(a)*23.05,z));}const line=new T.Line(new T.BufferGeometry().setFromPoints(points),new T.LineBasicMaterial({color:0x788a91,transparent:true,opacity:.5}));D.add(line);}});
  const plaster=canvasTexture(256,256,(c,w,h)=>{c.fillStyle='#c8c7ba';c.fillRect(0,0,w,h);for(let i=0;i<6500;i++){c.fillStyle=rnd()>.5?'#bdbcaf':'#d8d8cd';c.globalAlpha=.3;c.fillRect(rnd()*w,rnd()*h,rnd()*3+1,rnd()*5+1);}c.globalAlpha=1;});plaster.wrapS=plaster.wrapT=T.RepeatWrapping;plaster.repeat.set(3,8);
  scene.children.filter(o=>o.geometry?.type==='CylinderGeometry'&&o.geometry.parameters.height===44).forEach(o=>{o.material=new T.MeshStandardMaterial({map:plaster,color:0xbebfb4,roughness:.9});});
  for(let y=14;y<52;y+=5){const ring=mesh(new T.TorusGeometry(4.7,.025,4,24),metal,TW[0],y,TW[2],D);ring.rotation.x=Math.PI/2;}

  // Tower cab: eight mullions, balcony balusters, consoles, chairs and antenna arrays.
  for(let i=0;i<8;i++){const a=i*Math.PI/4;const x=TW[0]+Math.cos(a)*9.6,z=TW[2]+Math.sin(a)*9.6;rod([x,57.5,z],[x,64.5,z],.18,dark);}
  for(let i=0;i<24;i++){const a=i*Math.PI/12;const x=TW[0]+Math.cos(a)*10.4,z=TW[2]+Math.sin(a)*10.4;rod([x,55.8,z],[x,58,z],.09,metal);}
  const consoleScreen=textMaterial('RWY 10     CLEAR','#122d3a','#8dddcb',40);
  for(let i=0;i<5;i++){const a=i*Math.PI*.4;const x=TW[0]+Math.cos(a)*5,z=TW[2]+Math.sin(a)*5;const g=new T.Group();g.position.set(x,57.8,z);g.rotation.y=-a+Math.PI/2;D.add(g);B(3.7,1.2,1.5,dark,0,.6,0,g);const monitor=B(2.2,1.4,.15,dark,0,2,0,g);plane(2,1.2,consoleScreen,0,2,.09,0,0,0,g);cyl(.18,1.2,metal,0,.5,2.2,g);B(1.4,.3,1.4,dark,0,1.1,2.2,g);B(1.4,1.5,.3,dark,0,1.8,2.8,g);}
  for(let i=0;i<3;i++){const x=TW[0]-6+i*6,z=TW[2]-4;rod([x,66,z],[x,71+i*2,z],.1,metal);for(let j=0;j<3;j++)rod([x-1.4,68+j,z],[x+1.4,68+j,z],.055,metal);}
  B(1.6,4,.12,dark,TW[0],2,TW[2]+9.05);plane(5,1.1,textMaterial('TOWER','#283c48','#eae6d5',54),TW[0],6.5,TW[2]+9.1);
  // Service stairs and guardrails beside the tower.
  for(let i=0;i<14;i++){B(3,.26,1,concrete,204,.13+i*.25,-132+i*.75);}
  rod([202.5,1.3,-132],[202.5,4.6,-122],.1,metal);rod([205.5,1.3,-132],[205.5,4.6,-122],.1,metal);

  // Perimeter fence; thin instanced metal posts with lightweight diamond wire planes.
  const fenceTex=canvasTexture(64,64,(c,w,h)=>{c.strokeStyle='#aab2ae';c.lineWidth=1.3;c.beginPath();c.moveTo(0,0);c.lineTo(w,h);c.moveTo(w,0);c.lineTo(0,h);c.stroke();});fenceTex.wrapS=fenceTex.wrapT=T.RepeatWrapping;fenceTex.repeat.set(240,2);
  const fenceMat=new T.MeshStandardMaterial({map:fenceTex,transparent:true,alphaTest:.18,side:T.DoubleSide,roughness:.5,metalness:.6});
  for(const z of [-253,248]){plane(1140,2.8,fenceMat,0,1.5,z);rod([-570,3,z],[570,3,z],.055,metal);}
  const posts=new T.InstancedMesh(new T.CylinderGeometry(.07,.07,3.3,6),metal,384);const dummy=new T.Object3D();let pi=0;
  for(const z of [-253,248])for(let x=-570;x<=570;x+=6){dummy.position.set(x,1.6,z);dummy.updateMatrix();posts.setMatrixAt(pi++,dummy.matrix);}posts.count=pi;posts.castShadow=false;D.add(posts);
  for(let i=0;i<5;i++)sign('RESTRICTED AREA',-440+i*210,246,0,5);
  // Parking area with curbs, striping, cars and service vans.
  B(210,.2,40,std(0x747c7e),120,.1,-221);
  for(let x=24;x<215;x+=10){B(.15,.04,14,white,x,.22,-212);B(.15,.04,14,white,x,.22,-233);}
  B(215,.4,.6,concrete,120,.3,-242);B(215,.4,.6,concrete,120,.3,-200);
  function vehicle(x,z,color,angle=0,type='car'){
    const g=new T.Group();g.position.set(x,0,z);g.rotation.y=angle;D.add(g);
    B(type==='truck'?8:4.5,1.2,2, std(color,{metalness:.25,roughness:.4}),0,1.1,0,g);
    B(2.5,1.2,1.85,glass,.2,2.1,0,g);B(2.5,.15,1.95,std(color,{metalness:.25,roughness:.4}),.2,2.75,0,g);
    B(.13,.4,1.7,white,2.3,1,0,g);B(.13,.25,1.6,dark,-2.3,1,0,g);
    for(const a of [-1.5,1.5])for(const b of [-1.05,1.05]){const wheel=cyl(.48,.23,rubber,a,.55,b,g);wheel.rotation.x=Math.PI/2;}
    if(type==='truck'){const tank=mesh(new T.CylinderGeometry(1.4,1.4,4.6,16),std(0xc2c4be,{metalness:.6,roughness:.35}),-1.7,2.6,0,g);tank.rotation.z=Math.PI/2;B(1.8,.18,.5,yellow,.7,2.95,0,g);}
    return g;
  }
  const carColors=[0xc7cecb,0x334b60,0x6d7a77,0xbec2c1,0x7c3030];
  for(let i=0;i<12;i++){if(i%5===3)continue;vehicle(30+i*15,-214,carColors[i%5],Math.PI/2);}
  vehicle(-18,-120,0xe4e5db,0,'truck');vehicle(148,-147,0xe3aa25,Math.PI);
  const service=vehicle(-470,-238,0xe3debc,0);W.serviceVehicle=service;
  // Fuel island, extinguisher boxes, cones and luggage carts.
  B(14,.4,10,concrete,-28,.3,-155);for(const x of [-32,-26]){B(1.5,3,1.3,std(0xd8dfdc),x,1.9,-155);B(1.2,.8,.1,dark,x,2.5,-154.3);rod([x+.85,2.8,-155],[x+.85,.8,-154.5],.11,rubber);}
  sign('AVGAS  |  JET A',-27,-158,Math.PI,7);
  for(let i=0;i<14;i++){const x=-45+i*3.3,z=-150+(i%2)*3;const cone=mesh(new T.ConeGeometry(.35,1.1,12),std(0xe66e24),x,.7,z,D);cyl(.22,.16,white,x,.77,z);B(.8,.12,.8,rubber,x,.1,z);}
  for(let i=0;i<3;i++){const x=-90+i*5;B(4,.18,2.2,metal,x,1,-147);B(4,.8,.12,metal,x,1.45,-148);for(const a of [-1.4,1.4])for(const z of [-147.9,-146.1]){const r=cyl(.35,.2,rubber,x+a,.4,z);r.rotation.x=Math.PI/2;}rod([x+2,.6,-147],[x+3.4,.4,-147],.1,metal);}

  // Sensor close-up: optical lenses, mounting hardware, screen UI, cable and battery.
  const screen=canvasTexture(256,512,(c,w,h)=>{c.fillStyle='#123c52';c.fillRect(0,0,w,h);c.fillStyle='#628077';c.fillRect(0,290,w,222);c.fillStyle='#323e44';c.fillRect(80,290,96,222);c.strokeStyle='#fff';c.setLineDash([20,15]);c.beginPath();c.moveTo(128,320);c.lineTo(128,512);c.stroke();c.setLineDash([]);c.fillStyle='#fff';c.font='bold 16px Arial';c.fillText('SKYSENTRY',20,36);c.font='12px monospace';c.fillText('RUNWAY-EAST',20,60);c.fillStyle='#e9b82e';c.fillRect(20,430,215,45);c.fillStyle='#142a35';c.fillText('CAMERA ACTIVE',42,458);c.strokeStyle='#9cc9e7';c.strokeRect(70,180,45,40);c.strokeRect(145,145,43,40);c.fillStyle='#192c36';c.beginPath();c.ellipse(w/2,15,25,5,0,0,Math.PI*2);c.fill();});
  phone.children.find(o=>o.geometry?.type==='PlaneGeometry').material=new T.MeshBasicMaterial({map:screen});
  B(.5,.9,.07,dark,-.53,.97,-.165,phone);
  for(const y of [.74,1.05,1.34]){const lens=cyl(.105,.08,metal,-.55,y,-.22,phone);lens.rotation.x=Math.PI/2;const optic=cyl(.075,.085,glass,-.55,y,-.23,phone);optic.rotation.x=Math.PI/2;}
  B(.07,.6,.08,metal,.93,.6,0,phone);B(.07,.25,.08,metal,-.93,.8,0,phone);
  cyl(.21,.4,metal,0,5.6,0,station);B(.5,.15,1.2,dark,0,5.9,0,station);
  const cablePath=new T.CatmullRomCurve3([new T.Vector3(0,4.7,0),new T.Vector3(.7,3.5,.25),new T.Vector3(.8,1.5,.4),new T.Vector3(2.4,.9,.8)]);
  mesh(new T.TubeGeometry(cablePath,24,.035,6,false),rubber,0,0,0,station);
  plane(1.8,.65,textMaterial('POWER  98%','#192b32','#a6d48d',43),2.6,.85,1.62,0,0,0,station);
  for(const a of [0,2.1,4.2]){B(.35,.16,.5,rubber,Math.cos(a)*1.65,.1,Math.sin(a)*1.65,station);const collar=cyl(.16,.18,metal,Math.cos(a)*.9,3.7,Math.sin(a)*.9,station);}

  // More organic trees at the exact original positions, with trunks and varied crowns.
  const trunks=new T.InstancedMesh(new T.CylinderGeometry(.32,.5,7,7),std(0x665746,{roughness:1}),520);
  const foliage=new T.InstancedMesh(new T.IcosahedronGeometry(1,2),std(0x5c6a39,{roughness:1}),520*4);
  trunks.castShadow=foliage.castShadow=true;foliage.receiveShadow=true;const matrix=new T.Matrix4(),pos=new T.Vector3(),q=new T.Quaternion(),scale=new T.Vector3();
  for(let i=0;i<520;i++){trees.getMatrixAt(i,matrix);matrix.decompose(pos,q,scale);dummy.position.copy(pos).add(new T.Vector3(0,3.1*scale.y,0));dummy.scale.copy(scale);dummy.quaternion.copy(q);dummy.updateMatrix();trunks.setMatrixAt(i,dummy.matrix);
    for(let j=0;j<4;j++){const a=j*2.4+i;dummy.position.copy(pos).add(new T.Vector3(Math.sin(a)*2*scale.x,(7+j*.65)*scale.y,Math.cos(a)*2*scale.z));dummy.scale.set((3+rnd())*scale.x,(3.2+rnd()*1.6)*scale.y,(3+rnd())*scale.z);dummy.updateMatrix();foliage.setMatrixAt(i*4+j,dummy.matrix);foliage.setColorAt(i*4+j,new T.Color().setHSL(.19+rnd()*.07,.23+rnd()*.15,.26+rnd()*.10));}}
  trees.visible=false;bush.geometry=new T.SphereGeometry(4.5,10,7);bush.material.color.setHex(0x637c4c);D.add(trunks,foliage);
  // Low, non-cartoon grassy verge tufts, instanced away from paved surfaces.
  const blades=new T.InstancedMesh(new T.ConeGeometry(.23,1.1,3),std(0x798550,{side:T.DoubleSide,roughness:1}),1800);
  for(let i=0;i<1800;i++){const x=(rnd()-.5)*920,z=(rnd()<.5?-1:1)*(19+rnd()*7);dummy.position.set(x,.42,z);dummy.scale.set(.5+rnd(),.25+rnd()*.4,.5+rnd());dummy.rotation.set(0,rnd()*6.28,0);dummy.updateMatrix();blades.setMatrixAt(i,dummy.matrix);blades.setColorAt(i,new T.Color().setHSL(.19+rnd()*.05,.25,.33+rnd()*.16));}D.add(blades);

  // Geese retain their original flock animation; add necks, cheek patches and layered feathers.
  const gooseBody=std(0x706959,{roughness:1}),feather=std(0x494c43,{side:T.DoubleSide,roughness:1}),black=std(0x242a2a),cream=std(0xc5c5b2);
  W.birds.forEach(b=>{
    b.children[0].material=gooseBody;b.children[1].visible=false;
    const neck=mesh(new T.SphereGeometry(.19,10,6),black,1.03,.16,0,b);neck.scale.set(3.3,.82,.9);
    mesh(new T.SphereGeometry(.27,10,8),black,1.68,.20,0,b);
    const beak=mesh(new T.ConeGeometry(.11,.45,8),black,2.02,.19,0,b);beak.rotation.z=-Math.PI/2;
    for(const s of [-1,1]){const cheek=mesh(new T.SphereGeometry(.13,8,6),cream,1.61,.16,s*.19,b);cheek.scale.set(1,.75,.45);mesh(new T.SphereGeometry(.04,6,4),basic(0x0c1213),1.78,.27,s*.21,b);}
    [b.userData.wl,b.userData.wr].forEach((wing,k)=>{const sign=k? -1:1;wing.children[0].material=gooseBody;for(let j=0;j<7;j++){const f=mesh(new T.SphereGeometry(1,8,4),feather,-.35-j*.055,-.025,sign*(.6+j*.27),wing);f.scale.set(.6-j*.038,.027,.20);f.rotation.y=sign*.4;}});
    const tail=mesh(new T.SphereGeometry(1,8,4),feather,-1,.02,0,b);tail.scale.set(.6,.08,.44);
  });
  // Quadcopter gimbal, optical lens, skid legs, cooling fins and actual propeller blades.
  const dg=W.drone;B(.75,.55,.65,metal,.9,-.55,0,dg);const lens=cyl(.19,.24,glass,1.33,-.6,0,dg);lens.rotation.z=Math.PI/2;
  for(const z of [-.9,.9]){rod([-.8,-.35,z],[-1,-1.2,z],.06,dark,dg);rod([.8,-.35,z],[1,-1.2,z],.06,dark,dg);rod([-1.2,-1.2,z],[1.2,-1.2,z],.075,dark,dg);}
  for(let i=0;i<7;i++)B(.07,.03,1.2,metal,-.6+i*.2,.37,0,dg);
  W.rotors.forEach(r=>{cyl(.18,.35,metal,0,.05,0,r);B(2.35,.035,.16,dark,0,.15,0,r);B(.16,.035,2.35,dark,0,.15,0,r);r.material.opacity=.12;});

  // Server and service tiles: rack ventilation and small emissive status indicators.
  for(let i=0;i<4;i++){for(let j=0;j<8;j++)B(.5,2,.2,dark,W.SV.x-12+j*3.1,W.SV.y+8-i*5,W.SV.z+18.3,W.data);}
  W.spon.forEach((s,i)=>{for(let j=0;j<3;j++)B(2,.6,.2,basic(j===0?0xeed795:0xcce8ea),s.p.x-16+j*4,s.p.y-6,s.p.z+2,W.data);});

  W.detailUpdate=(time,gear)=>{
    W.fans?.forEach((g,i)=>g.rotation.x=(i?1:-1)*time*48);
    if(W.planeBeacon)W.planeBeacon.visible=(time%1.3)<.15;
    W.serviceVehicle.position.x=-470+(time*6)%820;
  };
  // Merge static detail meshes by material to reduce draw calls while keeping animation groups separate.
  D.updateMatrixWorld(true);const buckets=new Map(),remove=[];
  D.traverse(o=>{if(!o.isMesh||o.isInstancedMesh||Array.isArray(o.material)||o.parent===W.serviceVehicle)return;let p=o.parent;while(p){if(p===W.serviceVehicle)return;p=p.parent;}const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);const key=o.material.uuid;if(!buckets.has(key))buckets.set(key,{mat:o.material,geos:[]});buckets.get(key).geos.push(g);remove.push(o);});
  const merged=new T.Group();merged.name='Batched static airfield details';
  for(const {mat,geos} of buckets.values()){try{const geo=mergeGeometries(geos);if(geo){const m=new T.Mesh(geo,mat);m.castShadow=!mat.transparent;m.receiveShadow=true;merged.add(m);}}finally{geos.forEach(g=>g.dispose());}}
  // All generated primitives have matching normal/uv attributes; instanced foliage stays separate.
  remove.forEach(o=>o.removeFromParent());scene.add(merged);
  const results=await Promise.allSettled(pending);const failed=results.filter(r=>r.status==='rejected');
  if(failed.length){document.getElementById('assetStatus').textContent='Some detail assets could not load; base scene remains available.';failed.forEach(r=>console.error(r.reason));}
}
