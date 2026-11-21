// Decode embedded base64 data: URIs natively via fetch() when permitted, falling back to a
// tight pre-allocated byte loop if a hosted page CSP blocks fetch('data:...').
async function decodeDataUri(uri) {
  try {
    const res = await fetch(uri);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {}
  const raw = atob(uri.slice(uri.indexOf(',') + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// A *.gltf.json file with one base64 buffer becomes an in-memory GLB, so GLTFLoader reads
// the geometry without a network request. Relative texture paths still resolve via `base`.
export async function loadGltfJson(loader, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  const json = await response.json();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const buf = json.buffers?.[0];
  if (!buf?.uri?.startsWith('data:') || json.buffers.length > 1) return loader.parseAsync(json, base);
  const bin = await decodeDataUri(buf.uri);
  delete buf.uri; buf.byteLength = bin.length;
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = (enc.length + 3) & ~3, binLen = (bin.length + 3) & ~3;
  const glb = new Uint8Array(12 + 8 + jsonLen + 8 + binLen), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
  view.setUint32(12, jsonLen, true); view.setUint32(16, 0x4E4F534A, true);
  glb.set(enc, 20); glb.fill(0x20, 20 + enc.length, 20 + jsonLen);
  const b = 20 + jsonLen; view.setUint32(b, binLen, true); view.setUint32(b + 4, 0x004E4942, true);
  glb.set(bin, b + 8);
  // The scanned props use external textures, so no browser-global image loader override is needed.
  return loader.parseAsync(glb.buffer, base);
}
