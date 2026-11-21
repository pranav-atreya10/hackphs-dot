export const V5_ONNX_SHA256 = 'b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a';
const V5_MAX_BYTES = 20_000_000;
const MAX_PIXELS = 8_000_000;
const MAX_BOXES = 8;
const MAX_BOX_SIDE = 4096;

const INPUT_SIZE = 96;
const CROP_CONTEXT = 1.4;
const CROP_MIN_SIDE = 32;
const CLASSES = ['bird', 'drone', 'other'];
const INPUT_NAME = 'crop96_normalised';
const OUTPUT_NAME = 'logits';

const MEAN = new Float32Array([0.485, 0.456, 0.406]);
const STD = new Float32Array([0.229, 0.224, 0.225]);

const PREC = 22;
const HALF = 1 << (PREC - 1);
const ONE = 1 << PREC;

const textDecoder = new TextDecoder('utf-8', { fatal: false });
let classifierPromise;

// ---------------------------------------------------------------------------------------------------
// Minimal self-contained ONNX Protobuf parser (ModelProto / GraphProto / NodeProto / TensorProto)
// ---------------------------------------------------------------------------------------------------

function readVarintBig(bytes, pos, end) {
  let result = 0n;
  let shift = 0n;
  while (pos < end) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (shift > 63n && (b > 1)) throw new Error('Malformed ONNX varint overflow');
      return [result, pos];
    }
    shift += 7n;
    if (shift > 64n) throw new Error('Malformed ONNX varint (>10 bytes)');
  }
  throw new Error('Unexpected EOF reading ONNX varint');
}

function readSignedInt64(bytes, pos, end) {
  const [raw, next] = readVarintBig(bytes, pos, end);
  return [Number(BigInt.asIntN(64, raw)), next];
}

function readUint32Varint(bytes, pos, end) {
  const [raw, next] = readVarintBig(bytes, pos, end);
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0) throw new Error('Invalid ONNX unsigned length');
  return [num, next];
}

function skipField(bytes, wireType, pos, end) {
  if (wireType === 0) return readVarintBig(bytes, pos, end)[1];
  if (wireType === 1) {
    if (pos + 8 > end) throw new Error('Unexpected EOF in ONNX 64-bit field');
    return pos + 8;
  }
  if (wireType === 2) {
    const [len, p2] = readUint32Varint(bytes, pos, end);
    if (p2 + len > end) throw new Error('Unexpected EOF in ONNX length-delimited field');
    return p2 + len;
  }
  if (wireType === 5) {
    if (pos + 4 > end) throw new Error('Unexpected EOF in ONNX 32-bit field');
    return pos + 4;
  }
  throw new Error(`Unsupported ONNX protobuf wire type ${wireType}`);
}

function parseValueInfoName(bytes, start, end) {
  let pos = start;
  let name = '';
  while (pos < end) {
    const [tag, p1] = readUint32Varint(bytes, pos, end);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 1 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX ValueInfo name');
      name = textDecoder.decode(bytes.subarray(p2, p2 + len));
      pos = p2 + len;
    } else {
      pos = skipField(bytes, wt, pos, end);
    }
  }
  return name;
}

function parseTensorProto(bytes, start, end) {
  const dims = [];
  let dataType = 0;
  let name = '';
  let rawStart = -1;
  let rawLen = 0;
  const floatValues = [];
  let pos = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos < end) {
    const [tag, p1] = readUint32Varint(bytes, pos, end);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;

    if (field === 1) {
      if (wt === 0) {
        const [d, p2] = readSignedInt64(bytes, pos, end);
        dims.push(d);
        pos = p2;
      } else if (wt === 2) {
        const [len, p2] = readUint32Varint(bytes, pos, end);
        const subEnd = p2 + len;
        if (subEnd > end) throw new Error('Truncated ONNX tensor dims');
        let p = p2;
        while (p < subEnd) {
          const [d, pNext] = readSignedInt64(bytes, p, subEnd);
          dims.push(d);
          p = pNext;
        }
        pos = subEnd;
      } else {
        throw new Error('Invalid wire type for ONNX tensor dims');
      }
    } else if (field === 2 && wt === 0) {
      const [dt, p2] = readUint32Varint(bytes, pos, end);
      dataType = dt;
      pos = p2;
    } else if (field === 4) {
      if (wt === 5) {
        if (pos + 4 > end) throw new Error('Truncated ONNX float_data');
        floatValues.push(view.getFloat32(pos, true));
        pos += 4;
      } else if (wt === 2) {
        const [len, p2] = readUint32Varint(bytes, pos, end);
        if (p2 + len > end || len % 4 !== 0) throw new Error('Invalid packed ONNX float_data');
        for (let o = 0; o < len; o += 4) floatValues.push(view.getFloat32(p2 + o, true));
        pos = p2 + len;
      } else {
        throw new Error('Invalid wire type for ONNX float_data');
      }
    } else if (field === 8 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX tensor name');
      name = textDecoder.decode(bytes.subarray(p2, p2 + len));
      pos = p2 + len;
    } else if (field === 9 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX tensor raw_data');
      rawStart = p2;
      rawLen = len;
      pos = p2 + len;
    } else if (field === 13) {
      throw new Error(`External ONNX tensor data is not allowed (${name || 'unnamed'})`);
    } else if (field === 14 && wt === 0) {
      const [loc, p2] = readUint32Varint(bytes, pos, end);
      if (loc !== 0) throw new Error(`External ONNX tensor location is not allowed (${name || 'unnamed'})`);
      pos = p2;
    } else {
      pos = skipField(bytes, wt, pos, end);
    }
  }

  if (dataType !== 1) {
    throw new Error(`Unsupported ONNX initializer data_type ${dataType} for ${name || 'tensor'}`);
  }
  let elemCount = 1;
  for (let i = 0; i < dims.length; i++) {
    if (!Number.isSafeInteger(dims[i]) || dims[i] < 0) throw new Error(`Invalid tensor dimension in ${name}`);
    elemCount *= dims[i];
  }

  let data;
  if (rawStart >= 0) {
    if (rawLen !== elemCount * 4) {
      throw new Error(`ONNX tensor ${name} raw_data size mismatch (${rawLen} vs ${elemCount * 4})`);
    }
    const copy = new Uint8Array(bytes.subarray(rawStart, rawStart + rawLen));
    data = new Float32Array(copy.buffer, 0, elemCount);
  } else {
    if (floatValues.length !== elemCount) {
      throw new Error(`ONNX tensor ${name} float_data count mismatch`);
    }
    data = Float32Array.from(floatValues);
  }

  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`Non-finite weight in ONNX tensor ${name}`);
  }

  return { name, dims, data };
}

function parseAttributeProto(bytes, start, end) {
  let name = '';
  let fVal;
  let iVal;
  const ints = [];
  const floats = [];
  let pos = start;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (pos < end) {
    const [tag, p1] = readUint32Varint(bytes, pos, end);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;

    if (field === 1 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX attribute name');
      name = textDecoder.decode(bytes.subarray(p2, p2 + len));
      pos = p2 + len;
    } else if (field === 2 && wt === 5) {
      if (pos + 4 > end) throw new Error('Truncated ONNX float attribute');
      fVal = view.getFloat32(pos, true);
      pos += 4;
    } else if (field === 3 && wt === 0) {
      const [v, p2] = readSignedInt64(bytes, pos, end);
      iVal = v;
      pos = p2;
    } else if (field === 5 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX attribute tensor');
      // Inspect nested tensor to reject external data even in attributes.
      parseTensorProto(bytes, p2, p2 + len);
      pos = p2 + len;
    } else if (field === 7) {
      if (wt === 5) {
        if (pos + 4 > end) throw new Error('Truncated ONNX floats attribute');
        floats.push(view.getFloat32(pos, true));
        pos += 4;
      } else if (wt === 2) {
        const [len, p2] = readUint32Varint(bytes, pos, end);
        if (p2 + len > end || len % 4 !== 0) throw new Error('Invalid packed ONNX floats attribute');
        for (let o = 0; o < len; o += 4) floats.push(view.getFloat32(p2 + o, true));
        pos = p2 + len;
      } else {
        throw new Error('Invalid wire type for ONNX floats attribute');
      }
    } else if (field === 8) {
      if (wt === 0) {
        const [v, p2] = readSignedInt64(bytes, pos, end);
        ints.push(v);
        pos = p2;
      } else if (wt === 2) {
        const [len, p2] = readUint32Varint(bytes, pos, end);
        const subEnd = p2 + len;
        if (subEnd > end) throw new Error('Truncated ONNX ints attribute');
        let p = p2;
        while (p < subEnd) {
          const [v, pNext] = readSignedInt64(bytes, p, subEnd);
          ints.push(v);
          p = pNext;
        }
        pos = subEnd;
      } else {
        throw new Error('Invalid wire type for ONNX ints attribute');
      }
    } else {
      pos = skipField(bytes, wt, pos, end);
    }
  }

  let value;
  if (ints.length > 0) value = ints;
  else if (floats.length > 0) value = floats;
  else if (iVal !== undefined) value = iVal;
  else if (fVal !== undefined) value = fVal;
  return { name, value };
}

function parseNodeProto(bytes, start, end) {
  const inputs = [];
  const outputs = [];
  const attrs = Object.create(null);
  let name = '';
  let opType = '';
  let pos = start;

  while (pos < end) {
    const [tag, p1] = readUint32Varint(bytes, pos, end);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;

    if ((field === 1 || field === 2 || field === 3 || field === 4) && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX node string');
      const str = textDecoder.decode(bytes.subarray(p2, p2 + len));
      if (field === 1) inputs.push(str);
      else if (field === 2) outputs.push(str);
      else if (field === 3) name = str;
      else opType = str;
      pos = p2 + len;
    } else if (field === 5 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX node attribute');
      const attr = parseAttributeProto(bytes, p2, p2 + len);
      if (attr.name) attrs[attr.name] = attr.value;
      pos = p2 + len;
    } else {
      pos = skipField(bytes, wt, pos, end);
    }
  }

  return { name, opType, inputs, outputs, attrs };
}

export function parseOnnxModel(bufferOrBytes) {
  const bytes = bufferOrBytes instanceof Uint8Array
    ? bufferOrBytes
    : new Uint8Array(bufferOrBytes);
  if (bytes.byteLength === 0) throw new Error('Empty ONNX buffer');

  let graphStart = -1;
  let graphEnd = -1;
  let pos = 0;
  const end = bytes.byteLength;

  while (pos < end) {
    const [tag, p1] = readUint32Varint(bytes, pos, end);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 7 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, end);
      if (p2 + len > end) throw new Error('Truncated ONNX GraphProto');
      graphStart = p2;
      graphEnd = p2 + len;
      pos = graphEnd;
    } else {
      pos = skipField(bytes, wt, pos, end);
    }
  }

  if (graphStart < 0) throw new Error('ONNX ModelProto contains no graph');

  const nodes = [];
  const initializers = new Map();
  const graphInputs = [];
  const graphOutputs = [];

  pos = graphStart;
  while (pos < graphEnd) {
    const [tag, p1] = readUint32Varint(bytes, pos, graphEnd);
    pos = p1;
    const field = tag >>> 3;
    const wt = tag & 7;

    if (field === 1 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, graphEnd);
      if (p2 + len > graphEnd) throw new Error('Truncated ONNX NodeProto');
      nodes.push(parseNodeProto(bytes, p2, p2 + len));
      pos = p2 + len;
    } else if (field === 5 && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, graphEnd);
      if (p2 + len > graphEnd) throw new Error('Truncated ONNX initializer TensorProto');
      const tensor = parseTensorProto(bytes, p2, p2 + len);
      initializers.set(tensor.name, tensor);
      pos = p2 + len;
    } else if ((field === 11 || field === 12) && wt === 2) {
      const [len, p2] = readUint32Varint(bytes, pos, graphEnd);
      if (p2 + len > graphEnd) throw new Error('Truncated ONNX ValueInfoProto');
      const viName = parseValueInfoName(bytes, p2, p2 + len);
      if (field === 11) graphInputs.push(viName);
      else graphOutputs.push(viName);
      pos = p2 + len;
    } else {
      pos = skipField(bytes, wt, pos, graphEnd);
    }
  }

  return { nodes, initializers, inputs: graphInputs, outputs: graphOutputs };
}

// ---------------------------------------------------------------------------------------------------
// MobileNetV3-Large ONNX Operator Evaluators (Float32 NCHW)
// ---------------------------------------------------------------------------------------------------

function evalConv(X, W, B, attrs) {
  const [N, C, H, W_in] = X.dims;
  const [M, cPerGroup, kH, kW] = W.dims;
  const group = attrs.group ?? 1;
  const pads = attrs.pads ?? [0, 0, 0, 0];
  const strides = attrs.strides ?? [1, 1];
  const dilations = attrs.dilations ?? [1, 1];
  const [pTop, pLeft, pBottom, pRight] = pads;
  const [sH, sW] = strides;
  const [dH, dW] = dilations;

  if (C !== cPerGroup * group || M % group !== 0) {
    throw new Error('Conv channel/group mismatch');
  }

  const oH = Math.floor((H + pTop + pBottom - dH * (kH - 1) - 1) / sH) + 1;
  const oW = Math.floor((W_in + pLeft + pRight - dW * (kW - 1) - 1) / sW) + 1;
  const outDims = [N, M, oH, oW];
  const Y = new Float32Array(N * M * oH * oW);
  const xData = X.data;
  const wData = W.data;
  const bData = B ? B.data : null;

  // Fast path 1: Pointwise 1x1 conv (group=1, stride=1, pad=0, dilation=1)
  if (
    group === 1 &&
    kH === 1 &&
    kW === 1 &&
    pTop === 0 &&
    pLeft === 0 &&
    pBottom === 0 &&
    pRight === 0 &&
    sH === 1 &&
    sW === 1
  ) {
    const HW = H * W_in;
    if (HW === 1) {
      for (let n = 0; n < N; n++) {
        const xBatch = n * C;
        const yBatch = n * M;
        for (let m = 0; m < M; m++) {
          let sum = bData ? bData[m] : 0;
          const wBase = m * C;
          for (let c = 0; c < C; c++) {
            sum += wData[wBase + c] * xData[xBatch + c];
          }
          Y[yBatch + m] = sum;
        }
      }
      return { dims: outDims, data: Y };
    }

    for (let n = 0; n < N; n++) {
      const xBatch = n * C * HW;
      const yBatch = n * M * HW;
      let m = 0;
      for (; m + 3 < M; m += 4) {
        const y0 = yBatch + m * HW;
        const y1 = y0 + HW;
        const y2 = y1 + HW;
        const y3 = y2 + HW;
        if (bData) {
          if (bData[m] !== 0) Y.fill(bData[m], y0, y0 + HW);
          if (bData[m + 1] !== 0) Y.fill(bData[m + 1], y1, y1 + HW);
          if (bData[m + 2] !== 0) Y.fill(bData[m + 2], y2, y2 + HW);
          if (bData[m + 3] !== 0) Y.fill(bData[m + 3], y3, y3 + HW);
        }
        const w0Base = m * C;
        const w1Base = w0Base + C;
        const w2Base = w1Base + C;
        const w3Base = w2Base + C;
        for (let c = 0; c < C; c++) {
          const w0 = wData[w0Base + c];
          const w1 = wData[w1Base + c];
          const w2 = wData[w2Base + c];
          const w3 = wData[w3Base + c];
          const xBase = xBatch + c * HW;
          for (let p = 0; p < HW; p++) {
            const x = xData[xBase + p];
            Y[y0 + p] += w0 * x;
            Y[y1 + p] += w1 * x;
            Y[y2 + p] += w2 * x;
            Y[y3 + p] += w3 * x;
          }
        }
      }
      for (; m < M; m++) {
        const yBase = yBatch + m * HW;
        const bias = bData ? bData[m] : 0;
        if (bias !== 0) Y.fill(bias, yBase, yBase + HW);
        const wBase = m * C;
        for (let c = 0; c < C; c++) {
          const w = wData[wBase + c];
          const xBase = xBatch + c * HW;
          for (let p = 0; p < HW; p++) {
            Y[yBase + p] += w * xData[xBase + p];
          }
        }
      }
    }
    return { dims: outDims, data: Y };
  }

  // Fast path 2: Depthwise conv (group === C && M === C && dilation === 1)
  if (group === C && M === C && dH === 1 && dW === 1) {
    const inHW = H * W_in;
    const outHW = oH * oW;
    const kHW = kH * kW;
    for (let n = 0; n < N; n++) {
      const xBatch = n * C * inHW;
      const yBatch = n * C * outHW;
      for (let c = 0; c < C; c++) {
        const xPlane = xBatch + c * inHW;
        const yPlane = yBatch + c * outHW;
        const wPlane = c * kHW;
        const bias = bData ? bData[c] : 0;
        for (let oy = 0; oy < oH; oy++) {
          const iy0 = oy * sH - pTop;
          const kyMin = iy0 < 0 ? -iy0 : 0;
          const kyMax = iy0 + kH > H ? H - iy0 : kH;
          const yRow = yPlane + oy * oW;
          for (let ox = 0; ox < oW; ox++) {
            const ix0 = ox * sW - pLeft;
            const kxMin = ix0 < 0 ? -ix0 : 0;
            const kxMax = ix0 + kW > W_in ? W_in - ix0 : kW;
            let sum = bias;
            for (let ky = kyMin; ky < kyMax; ky++) {
              const xRow = xPlane + (iy0 + ky) * W_in + ix0;
              const wRow = wPlane + ky * kW;
              for (let kx = kxMin; kx < kxMax; kx++) {
                sum += xData[xRow + kx] * wData[wRow + kx];
              }
            }
            Y[yRow + ox] = sum;
          }
        }
      }
    }
    return { dims: outDims, data: Y };
  }

  // General NCHW grouped convolution
  const mPerGroup = M / group;
  const inHW = H * W_in;
  const outHW = oH * oW;
  const kHW = kH * kW;

  for (let n = 0; n < N; n++) {
    for (let g = 0; g < group; g++) {
      const cStart = g * cPerGroup;
      const mStart = g * mPerGroup;
      for (let mOff = 0; mOff < mPerGroup; mOff++) {
        const m = mStart + mOff;
        const yPlane = (n * M + m) * outHW;
        const wOutBase = m * cPerGroup * kHW;
        const bias = bData ? bData[m] : 0;
        for (let oy = 0; oy < oH; oy++) {
          const iyBase = oy * sH - pTop;
          const yRow = yPlane + oy * oW;
          for (let ox = 0; ox < oW; ox++) {
            const ixBase = ox * sW - pLeft;
            let sum = bias;
            for (let cOff = 0; cOff < cPerGroup; cOff++) {
              const xPlane = (n * C + cStart + cOff) * inHW;
              const wChanBase = wOutBase + cOff * kHW;
              for (let ky = 0; ky < kH; ky++) {
                const iy = iyBase + ky * dH;
                if (iy < 0 || iy >= H) continue;
                const xRow = xPlane + iy * W_in;
                const wRow = wChanBase + ky * kW;
                for (let kx = 0; kx < kW; kx++) {
                  const ix = ixBase + kx * dW;
                  if (ix < 0 || ix >= W_in) continue;
                  sum += xData[xRow + ix] * wData[wRow + kx];
                }
              }
            }
            Y[yRow + ox] = sum;
          }
        }
      }
    }
  }
  return { dims: outDims, data: Y };
}

function evalRelu(X) {
  const src = X.data;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    out[i] = v > 0 ? v : 0;
  }
  return { dims: X.dims.slice(), data: out };
}

function evalHardSigmoid(X, attrs) {
  const alpha = attrs.alpha ?? 0.2;
  const beta = attrs.beta ?? 0.5;
  const src = X.data;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = alpha * src[i] + beta;
    out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return { dims: X.dims.slice(), data: out };
}

function evalHardSwish(X) {
  const inv6 = 1 / 6;
  const src = X.data;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    const gate = x * inv6 + 0.5;
    out[i] = gate <= 0 ? 0 : gate >= 1 ? x : x * gate;
  }
  return { dims: X.dims.slice(), data: out };
}

function evalGlobalAveragePool(X) {
  const [N, C, H, W] = X.dims;
  const area = H * W;
  const src = X.data;
  const out = new Float32Array(N * C);
  for (let nc = 0; nc < N * C; nc++) {
    const base = nc * area;
    let sum = 0;
    for (let p = 0; p < area; p++) sum += src[base + p];
    out[nc] = sum / area;
  }
  return { dims: [N, C, 1, 1], data: out };
}

function computeStrides(dims) {
  const strides = new Int32Array(dims.length);
  let s = 1;
  for (let i = dims.length - 1; i >= 0; i--) {
    strides[i] = dims[i] === 1 ? 0 : s;
    s *= dims[i];
  }
  return strides;
}

function evalBinaryBroadcast(A, B, isMul) {
  const aDims = A.dims;
  const bDims = B.dims;
  const aData = A.data;
  const bData = B.data;

  // Fast path A: identical tensor shapes
  if (aDims.length === bDims.length && aDims.every((d, i) => d === bDims[i])) {
    const out = new Float32Array(aData.length);
    if (isMul) {
      for (let i = 0; i < aData.length; i++) out[i] = aData[i] * bData[i];
    } else {
      for (let i = 0; i < aData.length; i++) out[i] = aData[i] + bData[i];
    }
    return { dims: aDims.slice(), data: out };
  }

  // Fast path B: Squeeze-Excitation channel scale [N, C, 1, 1] * [N, C, H, W] (either order)
  if (
    aDims.length === 4 &&
    bDims.length === 4 &&
    aDims[0] === bDims[0] &&
    aDims[1] === bDims[1] &&
    ((aDims[2] === 1 && aDims[3] === 1) || (bDims[2] === 1 && bDims[3] === 1))
  ) {
    const aIsScale = aDims[2] === 1 && aDims[3] === 1;
    const feat = aIsScale ? B : A;
    const scale = aIsScale ? aData : bData;
    const [N, C, H, W] = feat.dims;
    const HW = H * W;
    const fData = feat.data;
    const out = new Float32Array(fData.length);
    for (let nc = 0; nc < N * C; nc++) {
      const s = scale[nc];
      const base = nc * HW;
      if (isMul) {
        for (let p = 0; p < HW; p++) out[base + p] = fData[base + p] * s;
      } else {
        for (let p = 0; p < HW; p++) out[base + p] = fData[base + p] + s;
      }
    }
    return { dims: [N, C, H, W], data: out };
  }

  // General ONNX multidirectional broadcast
  const rank = Math.max(aDims.length, bDims.length);
  const padA = new Array(rank).fill(1);
  const padB = new Array(rank).fill(1);
  const outDims = new Array(rank);
  for (let i = 0; i < rank; i++) {
    const da = i >= rank - aDims.length ? aDims[i - (rank - aDims.length)] : 1;
    const db = i >= rank - bDims.length ? bDims[i - (rank - bDims.length)] : 1;
    if (da !== db && da !== 1 && db !== 1) {
      throw new Error(`Incompatible ONNX broadcast shapes [${aDims}] vs [${bDims}]`);
    }
    padA[i] = da;
    padB[i] = db;
    outDims[i] = Math.max(da, db);
  }

  const aStrides = computeStrides(padA);
  const bStrides = computeStrides(padB);
  let total = 1;
  for (let i = 0; i < rank; i++) total *= outDims[i];
  const out = new Float32Array(total);
  const coords = new Int32Array(rank);

  for (let idx = 0; idx < total; idx++) {
    let ai = 0;
    let bi = 0;
    for (let d = 0; d < rank; d++) {
      ai += coords[d] * aStrides[d];
      bi += coords[d] * bStrides[d];
    }
    out[idx] = isMul ? aData[ai] * bData[bi] : aData[ai] + bData[bi];
    for (let d = rank - 1; d >= 0; d--) {
      coords[d]++;
      if (coords[d] < outDims[d]) break;
      coords[d] = 0;
    }
  }

  return { dims: outDims, data: out };
}

function evalFlatten(X, attrs) {
  let axis = attrs.axis ?? 1;
  if (axis < 0) axis += X.dims.length;
  let d0 = 1;
  let d1 = 1;
  for (let i = 0; i < axis; i++) d0 *= X.dims[i];
  for (let i = axis; i < X.dims.length; i++) d1 *= X.dims[i];
  return { dims: [d0, d1], data: X.data.slice() };
}

function evalGemm(A, B, C, attrs) {
  const alpha = attrs.alpha ?? 1.0;
  const beta = attrs.beta ?? 1.0;
  const transA = (attrs.transA ?? 0) !== 0;
  const transB = (attrs.transB ?? 0) !== 0;

  const M = transA ? A.dims[1] : A.dims[0];
  const K = transA ? A.dims[0] : A.dims[1];
  const Kb = transB ? B.dims[1] : B.dims[0];
  const N = transB ? B.dims[0] : B.dims[1];
  if (K !== Kb) throw new Error(`Gemm inner dimension mismatch (${K} vs ${Kb})`);

  const out = new Float32Array(M * N);
  const aData = A.data;
  const bData = B.data;
  const cData = C ? C.data : null;

  for (let m = 0; m < M; m++) {
    for (let n = 0; n < N; n++) {
      let sum = 0;
      if (!transA && transB) {
        const aRow = m * K;
        const bRow = n * K;
        for (let k = 0; k < K; k++) sum += aData[aRow + k] * bData[bRow + k];
      } else {
        for (let k = 0; k < K; k++) {
          const av = transA ? aData[k * M + m] : aData[m * K + k];
          const bv = transB ? bData[n * K + k] : bData[k * N + n];
          sum += av * bv;
        }
      }
      let cVal = 0;
      if (cData && beta !== 0) {
        if (cData.length === N) cVal = cData[n];
        else if (cData.length === 1) cVal = cData[0];
        else cVal = cData[m * N + n];
      }
      out[m * N + n] = alpha * sum + beta * cVal;
    }
  }
  return { dims: [M, N], data: out };
}

export function createPureJsOnnxRunner(bufferOrBytes) {
  const graph = parseOnnxModel(bufferOrBytes);
  if (!graph.inputs.includes(INPUT_NAME) && !graph.nodes.some(n => n.inputs.includes(INPUT_NAME))) {
    throw new Error(`ONNX model missing expected input "${INPUT_NAME}"`);
  }
  if (!graph.outputs.includes(OUTPUT_NAME)) {
    throw new Error(`ONNX model missing expected output "${OUTPUT_NAME}"`);
  }

  // Precompute last-use node index for transient activations so intermediate buffers free eagerly.
  const lastUse = new Map();
  for (let i = 0; i < graph.nodes.length; i++) {
    for (const inp of graph.nodes[i].inputs) {
      if (inp && !graph.initializers.has(inp)) lastUse.set(inp, i);
    }
  }
  for (const outName of graph.outputs) {
    lastUse.set(outName, graph.nodes.length);
  }

  function run(inputF32, batchSize = 1) {
    const expectedLen = batchSize * 3 * INPUT_SIZE * INPUT_SIZE;
    if (!(inputF32 instanceof Float32Array) || inputF32.length !== expectedLen) {
      throw new Error(`Expected Float32Array(${expectedLen}) for ${INPUT_NAME}`);
    }

    const values = new Map(graph.initializers);
    values.set(INPUT_NAME, { dims: [batchSize, 3, INPUT_SIZE, INPUT_SIZE], data: inputF32 });

    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i];
      const getVal = (idx) => {
        const name = node.inputs[idx];
        if (!name) return null;
        const v = values.get(name);
        if (!v) throw new Error(`Missing tensor "${name}" for ${node.opType}`);
        return v;
      };

      let result;
      switch (node.opType) {
        case 'Conv':
          result = evalConv(getVal(0), getVal(1), node.inputs.length > 2 ? getVal(2) : null, node.attrs);
          break;
        case 'Relu':
          result = evalRelu(getVal(0));
          break;
        case 'HardSigmoid':
          result = evalHardSigmoid(getVal(0), node.attrs);
          break;
        case 'HardSwish':
          result = evalHardSwish(getVal(0));
          break;
        case 'GlobalAveragePool':
          result = evalGlobalAveragePool(getVal(0));
          break;
        case 'Add':
          result = evalBinaryBroadcast(getVal(0), getVal(1), false);
          break;
        case 'Mul':
          result = evalBinaryBroadcast(getVal(0), getVal(1), true);
          break;
        case 'Flatten':
          result = evalFlatten(getVal(0), node.attrs);
          break;
        case 'Gemm':
          result = evalGemm(getVal(0), getVal(1), node.inputs.length > 2 ? getVal(2) : null, node.attrs);
          break;
        default:
          throw new Error(`Unsupported ONNX operator "${node.opType}" in v5 worker`);
      }

      values.set(node.outputs[0], result);

      for (const inp of node.inputs) {
        if (inp && !graph.initializers.has(inp) && lastUse.get(inp) === i) {
          values.delete(inp);
        }
      }
    }

    const outTensor = values.get(OUTPUT_NAME);
    if (!outTensor || outTensor.dims.length !== 2 || outTensor.dims[0] !== batchSize || outTensor.dims[1] !== CLASSES.length) {
      throw new Error('Unexpected logits shape from v5 ONNX graph');
    }
    for (let i = 0; i < outTensor.data.length; i++) {
      if (!Number.isFinite(outTensor.data[i])) throw new Error('Non-finite logits from v5 ONNX graph');
    }
    return outTensor.data;
  }

  return { run };
}

// ---------------------------------------------------------------------------------------------------
// Cropping (crops.py Pillow-exact BILINEAR to 96x96 + ImageNet normalization)
// ---------------------------------------------------------------------------------------------------

function roundHalfEven(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function squareForBox(box, width, height) {
  const bw = box.w * width;
  const bh = box.h * height;
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  const side = Math.max(CROP_CONTEXT * Math.max(bw, bh), CROP_MIN_SIDE);
  return {
    x0: roundHalfEven(cx - side / 2),
    y0: roundHalfEven(cy - side / 2),
    s: Math.max(roundHalfEven(side), 1),
  };
}

function pilCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const ss = 1 / filterscale;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const tmp = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) * ss);
      tmp[x] = t < 1 ? 1 - t : 0;
      ww += tmp[x];
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? tmp[x] / ww : tmp[x];
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * ONE) : Math.trunc(0.5 + v * ONE);
    }
    bounds[2 * xx] = xmin;
    bounds[2 * xx + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

function clip8(v) {
  v >>= PREC;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

class CropScratch96 {
  constructor() {
    this.cols = new Int32Array(0);
    this.tmp = new Int32Array(0);
    this.rgba = new Uint8ClampedArray(INPUT_SIZE * INPUT_SIZE * 4);
    this.tensor = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    this.coeffs = new Map();
  }

  colBuffer(n) {
    if (this.cols.length < n) this.cols = new Int32Array(n);
    return this.cols;
  }

  tmpBuffer(n) {
    if (this.tmp.length < n) this.tmp = new Int32Array(n);
    return this.tmp;
  }

  coeffsFor(inSize, outSize) {
    const key = inSize * 1024 + outSize;
    let c = this.coeffs.get(key);
    if (!c) {
      if (this.coeffs.size > 256) this.coeffs.clear();
      c = pilCoeffs(inSize, outSize);
      this.coeffs.set(key, c);
    }
    return c;
  }
}

function resizeSquareRgba(frame, x0, y0, s, n, out, scratch) {
  const { data, width, height } = frame;
  const cols = scratch.colBuffer(s);
  for (let i = 0; i < s; i++) {
    cols[i] = Math.min(Math.max(x0 + i, 0), width - 1) * 4;
  }
  const rowAt = (j) => Math.min(Math.max(y0 + j, 0), height - 1) * width * 4;
  if (s === n) {
    for (let j = 0, d = 0; j < n; j++) {
      const r = rowAt(j);
      for (let i = 0; i < n; i++, d += 4) {
        const p = r + cols[i];
        out[d] = data[p];
        out[d + 1] = data[p + 1];
        out[d + 2] = data[p + 2];
        out[d + 3] = 255;
      }
    }
    return;
  }
  const { ksize, bounds, kk } = scratch.coeffsFor(s, n);
  const yFirst = bounds[0];
  const yLast = bounds[2 * n - 2] + bounds[2 * n - 1];
  const tmp = scratch.tmpBuffer((yLast - yFirst) * n * 3);
  for (let j = yFirst, t = 0; j < yLast; j++) {
    const r = rowAt(j);
    for (let xx = 0; xx < n; xx++, t += 3) {
      const xmin = bounds[2 * xx];
      const xmax = bounds[2 * xx + 1];
      const kb = xx * ksize;
      let s0 = HALF;
      let s1 = HALF;
      let s2 = HALF;
      for (let x = 0; x < xmax; x++) {
        const p = r + cols[xmin + x];
        const k = kk[kb + x];
        s0 += data[p] * k;
        s1 += data[p + 1] * k;
        s2 += data[p + 2] * k;
      }
      tmp[t] = clip8(s0);
      tmp[t + 1] = clip8(s1);
      tmp[t + 2] = clip8(s2);
    }
  }
  for (let yy = 0, d = 0; yy < n; yy++) {
    const ymin = bounds[2 * yy] - yFirst;
    const ymax = bounds[2 * yy + 1];
    const kb = yy * ksize;
    for (let xx = 0; xx < n; xx++, d += 4) {
      let s0 = HALF;
      let s1 = HALF;
      let s2 = HALF;
      for (let y = 0; y < ymax; y++) {
        const t = ((ymin + y) * n + xx) * 3;
        const k = kk[kb + y];
        s0 += tmp[t] * k;
        s1 += tmp[t + 1] * k;
        s2 += tmp[t + 2] * k;
      }
      out[d] = clip8(s0);
      out[d + 1] = clip8(s1);
      out[d + 2] = clip8(s2);
      out[d + 3] = 255;
    }
  }
}

export function cropAndNormalize96(frame, box, scratch = new CropScratch96()) {
  const q = squareForBox(box, frame.width, frame.height);
  resizeSquareRgba(frame, q.x0, q.y0, q.s, INPUT_SIZE, scratch.rgba, scratch);
  const rgba = scratch.rgba;
  const tensor = scratch.tensor;
  const plane = INPUT_SIZE * INPUT_SIZE;
  const m0 = MEAN[0], m1 = MEAN[1], m2 = MEAN[2];
  const s0 = STD[0], s1 = STD[1], s2 = STD[2];
  const inv255 = Math.fround(1 / 255);
  for (let p = 0, s = 0; p < plane; p++, s += 4) {
    tensor[p] = (Math.fround(rgba[s] * inv255) - m0) / s0;
    tensor[plane + p] = (Math.fround(rgba[s + 1] * inv255) - m1) / s1;
    tensor[2 * plane + p] = (Math.fround(rgba[s + 2] * inv255) - m2) / s2;
  }
  return tensor;
}

function softmaxResult(logits) {
  let max = -Infinity;
  let best = 0;
  for (let k = 0; k < CLASSES.length; k++) {
    const v = logits[k];
    if (!Number.isFinite(v)) throw new Error('Classifier returned non-finite logits');
    if (v > max) {
      max = v;
      best = k;
    }
  }
  let sum = 0;
  const exps = new Float64Array(CLASSES.length);
  for (let k = 0; k < CLASSES.length; k++) {
    const e = Math.exp(logits[k] - max);
    exps[k] = e;
    sum += e;
  }
  if (!Number.isFinite(sum) || sum <= 0) throw new Error('Classifier returned invalid softmax sum');
  const probs = {
    bird: exps[0] / sum,
    drone: exps[1] / sum,
    other: exps[2] / sum,
  };
  const label = CLASSES[best];
  return { label, score: probs[label], probs };
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

async function sha256Hex(arrayBuffer) {
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', arrayBuffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function createV5ClassifierFromBuffer(arrayBuffer, { preferOrt = true } = {}) {
  const scratch = new CropScratch96();
  let runLogits;

  if (
    preferOrt &&
    globalThis.ort?.InferenceSession &&
    typeof globalThis.ort.InferenceSession.create === 'function' &&
    typeof globalThis.ort.Tensor === 'function'
  ) {
    const session = await globalThis.ort.InferenceSession.create(arrayBuffer, {
      executionProviders: ['wasm'],
    });
    runLogits = async (tensorF32) => {
      const inputTensor = new globalThis.ort.Tensor(
        'float32',
        tensorF32.slice(),
        [1, 3, INPUT_SIZE, INPUT_SIZE]
      );
      const outputs = await session.run({ [INPUT_NAME]: inputTensor });
      const out = outputs?.[OUTPUT_NAME]?.data;
      if (!out || out.length !== CLASSES.length) {
        throw new Error('Invalid logits returned by ort.InferenceSession');
      }
      return out;
    };
  } else {
    const runner = createPureJsOnnxRunner(arrayBuffer);
    runLogits = async (tensorF32) => runner.run(tensorF32, 1);
  }

  return {
    async classifyBoxes(frame, boxes) {
      const results = new Array(boxes.length);
      for (let i = 0; i < boxes.length; i++) {
        const t0 = now();
        const tensor = cropAndNormalize96(frame, boxes[i], scratch);
        const logits = await runLogits(tensor);
        const { label, score, probs } = softmaxResult(logits);
        const ms = Math.round((now() - t0) * 10) / 10;
        results[i] = { label, score, probs, ms, model: 'v5' };
      }
      return results;
    },
  };
}

async function load() {
  const response = await fetch('/ai-models/skysentry_v5.onnx', { mode: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load v5 ONNX model (HTTP ${response.status})`);
  const arrayBuffer = await response.arrayBuffer();
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength <= 0) {
    throw new Error('Empty v5 ONNX model');
  }
  if (arrayBuffer.byteLength > V5_MAX_BYTES) {
    throw new Error('v5 ONNX model exceeds 20 MB safety cap');
  }
  const digest = await sha256Hex(arrayBuffer);
  if (digest !== V5_ONNX_SHA256) {
    throw new Error('v5 ONNX model SHA-256 verification failed');
  }
  return createV5ClassifierFromBuffer(arrayBuffer);
}

function getClassifier() {
  classifierPromise ??= load().catch(error => {
    classifierPromise = undefined;
    throw error;
  });
  return classifierPromise;
}

function validateBatch(frame, boxes) {
  const { data, width, height } = frame ?? {};
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('Frame dimensions must be positive integers');
  }
  const pixels = width * height;
  if (pixels > MAX_PIXELS) throw new Error('Frame exceeds 8 megapixels');
  if (!(data instanceof Uint8ClampedArray) || data.length !== pixels * 4) {
    throw new Error('Frame must contain exactly width * height * 4 RGBA bytes as a Uint8ClampedArray');
  }
  if (!Array.isArray(boxes) || boxes.length > MAX_BOXES) {
    throw new Error('Expected an array of up to 8 boxes');
  }
  for (const box of boxes) {
    const { x, y, w, h } = box ?? {};
    if (
      ![x, y, w, h].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x + w > 1.001 ||
      y + h > 1.001
    ) {
      throw new Error('Expected a normalized box with positive area inside the frame');
    }
    if (Math.max(w * width, h * height) > MAX_BOX_SIDE) {
      throw new Error('Box exceeds 4096 pixels on one side');
    }
  }
  return { data, width, height };
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', async ({ data: request }) => {
    const requestId = request?.id;
    const id =
      Number.isSafeInteger(requestId) || (typeof requestId === 'string' && requestId.length > 0)
        ? requestId
        : null;
    try {
      if (id === null) throw new Error('Expected a request id (integer or nonempty string)');
      if (request.type === 'load') {
        await getClassifier();
        self.postMessage({ id, ok: true });
      } else if (request.type === 'classify') {
        const frame = validateBatch(request.frame, request.boxes);
        const classifier = await getClassifier();
        const results = (await classifier.classifyBoxes(frame, request.boxes)).map(
          ({ label, score, probs, ms, model }) => {
            const { bird, drone, other } = probs;
            if (![bird, drone, other].every(Number.isFinite)) {
              throw new Error('Classifier returned invalid probabilities');
            }
            return { label, score, probs: { bird, drone, other }, ms, model: model || 'v5' };
          }
        );
        self.postMessage({ id, ok: true, results });
      } else {
        throw new Error('Unknown request type');
      }
    } catch (error) {
      self.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : 'v5 worker failed',
      });
    }
  });
}
