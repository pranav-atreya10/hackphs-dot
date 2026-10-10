// Hosted pages may refuse fetch() of data: and blob: URLs, so embedded assets are
// decoded in JavaScript and handed to the loaders directly instead of by URL.

const decode = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// A *.gltf.json file with one base64 buffer becomes an in-memory GLB, so GLTFLoader reads
// the geometry without a network request. Relative texture paths still resolve via `base`.
export async function loadGltfJson(loader, url) {
  const json = await (await fetch(url)).json();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const buf = json.buffers?.[0];
  if (!buf?.uri?.startsWith('data:') || json.buffers.length > 1) return loader.loadAsync(url);
  const bin = decode(buf.uri.slice(buf.uri.indexOf(',') + 1));
  delete buf.uri; buf.byteLength = bin.length;
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (enc.length + 3) & ~3, binLen = (bin.length + 3) & ~3;
  const glb = new Uint8Array(12 + 8 + jsonLen + 8 + binLen), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
  view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4E4F534A, true);
  glb.set(enc, 20); glb.fill(0x20, 20 + enc.length, 20 + jsonLen);
  const b = 20 + jsonLen; view.setUint32(b, binLen, true); view.setUint32(b + 4, 0x004E4942, true);
  glb.set(bin, b + 8);
  // Images packed inside the GLB become blob: URLs; load them through <img> rather than fetch().
  const cib = globalThis.createImageBitmap;
  try { globalThis.createImageBitmap = undefined; return await loader.parseAsync(glb.buffer, base); }
  finally { globalThis.createImageBitmap = cib; }
}

// Base64 Radiance HDR parsed straight into a DataTexture.
export async function loadHdrJson(T, HDRLoader, url) {
  const { b64 } = await (await fetch(url)).json();
  const d = new HDRLoader().parse(decode(b64).buffer);
  const tex = new T.DataTexture(d.data, d.width, d.height, T.RGBAFormat, d.type);
  tex.colorSpace = T.LinearSRGBColorSpace; tex.minFilter = tex.magFilter = T.LinearFilter;
  tex.generateMipmaps = false; tex.flipY = true; tex.needsUpdate = true;
  return tex;
}
