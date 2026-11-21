// Advisory multi-camera 2D bearing intersection & uncertainty estimation (isomorphic ESM).
// Single-camera bearings NEVER produce a 2D map position; every stereo output is explicitly
// tagged advisory: true and geo_basis: 'stereo_bearing_intersection'.

const RAD = Math.PI / 180;
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const CHI2_2D_95_SCALE = Math.sqrt(5.991464547107979); // ~2.447746830680816 (95% 2D Gaussian ellipse)

export const STEREO_GEO_BASIS = 'stereo_bearing_intersection';
export const STEREO_DISCLAIMER = 'Advisory 2-camera bearing intersection — not radar or clearance';

const DEFAULT_MAX_SKEW_MS = 2500;
const DEFAULT_MAX_RANGE_M = 4000;
const DEFAULT_MIN_BASELINE_M = 8;
const DEFAULT_MIN_RAY_ANGLE_DEG = 6;
const DEFAULT_MAX_RAY_ANGLE_DEG = 174;
const DEFAULT_SIGMA_BEARING_DEG = 2.0;
const DEFAULT_POLYGON_VERTICES = 24;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

function normLon180(lonDeg) {
  const wrapped = ((lonDeg + 540) % 360) - 180;
  return wrapped === -180 && lonDeg > 0 ? 180 : wrapped;
}

function shortestAngleDiffDeg(aDeg, bDeg) {
  const d = ((aDeg - bDeg + 540) % 360) - 180;
  return Math.abs(d);
}

// Pinhole horizontal bearing matching PRANAV/public/detection/src/geo.js.
function pinholeBearingFromX(xNorm, headingDeg, hfovDeg) {
  const f = 0.5 / Math.tan((hfovDeg * RAD) / 2);
  return norm360(headingDeg + Math.atan((xNorm - 0.5) / f) / RAD);
}

function pinholeElevationFromY(yNorm, pitchDeg, hfovDeg, aspectHoverW = 0.75) {
  const vfovRad = 2 * Math.atan(Math.tan((hfovDeg * RAD) / 2) * aspectHoverW);
  const fy = 0.5 / Math.tan(vfovRad / 2);
  return pitchDeg - Math.atan((yNorm - 0.5) / fy) / RAD;
}

// Pose validation matching PRANAV/corridor-calibration.js rules:
// lat in [-90, 90], lon in [-180, 180], heading_deg in [0, 360), hfov_deg in (0, 180).
export function isValidCameraPose(pose) {
  if (!isPlainObject(pose)) return false;
  const { lat, lon, heading_deg: headingDeg, hfov_deg: hfovDeg, pitch_deg: pitchDeg } = pose;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
  if (!Number.isFinite(headingDeg) || headingDeg < 0 || headingDeg >= 360) return false;
  if (!Number.isFinite(hfovDeg) || hfovDeg <= 0 || hfovDeg >= 180) return false;
  if (pitchDeg !== undefined && pitchDeg !== null && (!Number.isFinite(pitchDeg) || Math.abs(pitchDeg) > 90)) {
    return false;
  }
  return true;
}

function extractCameraPose(input) {
  if (!isPlainObject(input)) return null;
  if (isPlainObject(input.camera) && isValidCameraPose(input.camera)) return input.camera;
  if (isPlainObject(input.config?.camera) && isValidCameraPose(input.config.camera)) return input.config.camera;
  if (isValidCameraPose(input)) return input;
  return null;
}

// Local tangent ENU scale (WGS-84 meridional M and prime-vertical N radii at lat0).
function createEnuFrame(lat0, lon0) {
  const latRad = lat0 * RAD;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.max(1e-7, Math.cos(latRad));
  const w = Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const meridionalM = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
  const primeVerticalN = WGS84_A / w;
  const metersPerDegLat = meridionalM * RAD;
  const metersPerDegLon = primeVerticalN * cosLat * RAD;

  return {
    lat0,
    lon0,
    metersPerDegLat,
    metersPerDegLon,
    toEnu(lat, lon) {
      const dLon = ((lon - lon0 + 540) % 360) - 180;
      const dLat = lat - lat0;
      return [dLon * metersPerDegLon, dLat * metersPerDegLat];
    },
    toLatLon(eastM, northM) {
      const lat = lat0 + northM / metersPerDegLat;
      const lon = normLon180(lon0 + eastM / metersPerDegLon);
      return [lat, lon];
    },
  };
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return NaN;
  const dLon = ((lon2 - lon1 + 540) % 360) - 180;
  const frame = createEnuFrame(0.5 * (lat1 + lat2), normLon180(lon1 + 0.5 * dLon));
  const [e1, n1] = frame.toEnu(lat1, lon1);
  const [e2, n2] = frame.toEnu(lat2, lon2);
  return Math.hypot(e2 - e1, n2 - n1);
}

export function bearingBetweenPoints(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const dLon = ((lon2 - lon1 + 540) % 360) - 180;
  const frame = createEnuFrame(0.5 * (lat1 + lat2), normLon180(lon1 + 0.5 * dLon));
  const [e1, n1] = frame.toEnu(lat1, lon1);
  const [e2, n2] = frame.toEnu(lat2, lon2);
  const de = e2 - e1;
  const dn = n2 - n1;
  if (Math.hypot(de, dn) < 1e-9) return null;
  return norm360(Math.atan2(de, dn) / RAD);
}

function extractNormalizedCenter(bboxOrTrack) {
  if (typeof bboxOrTrack === 'number') {
    return Number.isFinite(bboxOrTrack) && bboxOrTrack >= 0 && bboxOrTrack <= 1
      ? { xNorm: bboxOrTrack, yNorm: null }
      : null;
  }
  if (Array.isArray(bboxOrTrack) && bboxOrTrack.length >= 4) {
    const [x, y, w, h] = bboxOrTrack;
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) return null;
    const xNorm = x + 0.5 * w;
    const yNorm = y + 0.5 * h;
    if (xNorm < 0 || xNorm > 1 || yNorm < 0 || yNorm > 1) return null;
    return { xNorm, yNorm };
  }
  if (!isPlainObject(bboxOrTrack)) return null;
  const rawBox = bboxOrTrack.bbox !== undefined ? bboxOrTrack.bbox : bboxOrTrack;
  if (Array.isArray(rawBox)) return extractNormalizedCenter(rawBox);
  if (!isPlainObject(rawBox)) return null;

  if (Number.isFinite(rawBox.x) && Number.isFinite(rawBox.w)) {
    if (rawBox.w < 0) return null;
    if (rawBox.h !== undefined && (!Number.isFinite(rawBox.h) || rawBox.h < 0)) return null;
    const xNorm = rawBox.x + 0.5 * rawBox.w;
    const yNorm = Number.isFinite(rawBox.y) && Number.isFinite(rawBox.h)
      ? rawBox.y + 0.5 * rawBox.h
      : (Number.isFinite(rawBox.y) ? rawBox.y : null);
    if (xNorm < 0 || xNorm > 1) return null;
    if (yNorm !== null && (yNorm < 0 || yNorm > 1)) return null;
    return { xNorm, yNorm };
  }

  if (Number.isFinite(bboxOrTrack.x) && bboxOrTrack.x >= 0 && bboxOrTrack.x <= 1) {
    const yNorm = Number.isFinite(bboxOrTrack.y) && bboxOrTrack.y >= 0 && bboxOrTrack.y <= 1
      ? bboxOrTrack.y
      : null;
    return { xNorm: bboxOrTrack.x, yNorm };
  }
  return null;
}

export function bearingFromTrackBbox(bboxOrTrack, poseOrHeading, hfovMaybe) {
  const center = extractNormalizedCenter(bboxOrTrack);
  if (!center) return null;

  let headingDeg;
  let hfovDeg;
  if (typeof poseOrHeading === 'number' && typeof hfovMaybe === 'number') {
    headingDeg = poseOrHeading;
    hfovDeg = hfovMaybe;
    if (!Number.isFinite(headingDeg) || headingDeg < 0 || headingDeg >= 360) return null;
    if (!Number.isFinite(hfovDeg) || hfovDeg <= 0 || hfovDeg >= 180) return null;
  } else if (isPlainObject(poseOrHeading)) {
    const pose = poseOrHeading.camera && isPlainObject(poseOrHeading.camera) ? poseOrHeading.camera : poseOrHeading;
    if (pose.lat !== undefined || pose.lon !== undefined) {
      if (!isValidCameraPose(pose)) return null;
    } else {
      if (!Number.isFinite(pose.heading_deg) || pose.heading_deg < 0 || pose.heading_deg >= 360) return null;
      if (!Number.isFinite(pose.hfov_deg) || pose.hfov_deg <= 0 || pose.hfov_deg >= 180) return null;
    }
    headingDeg = pose.heading_deg;
    hfovDeg = pose.hfov_deg;
  } else {
    return null;
  }

  return pinholeBearingFromX(center.xNorm, headingDeg, hfovDeg);
}

function decomposeCovarianceEllipse(frame, eastInt, northInt, sigmaEE, sigmaEN, sigmaNN, polygonVertices) {
  const halfTrace = 0.5 * (sigmaEE + sigmaNN);
  const halfDiff = 0.5 * (sigmaEE - sigmaNN);
  const disc = Math.sqrt(Math.max(0, halfDiff * halfDiff + sigmaEN * sigmaEN));
  const lambdaMax = Math.max(1e-6, halfTrace + disc);
  const lambdaMin = Math.max(1e-6, halfTrace - disc);

  const semiMajor1SigmaM = Math.sqrt(lambdaMax);
  const semiMinor1SigmaM = Math.sqrt(lambdaMin);
  const semiMajor95M = CHI2_2D_95_SCALE * semiMajor1SigmaM;
  const semiMinor95M = Math.max(0.5, CHI2_2D_95_SCALE * semiMinor1SigmaM);

  // Angle of major axis counter-clockwise from East in ENU.
  const phiRad = 0.5 * Math.atan2(2 * sigmaEN, sigmaEE - sigmaNN);
  const cosPhi = Math.cos(phiRad);
  const sinPhi = Math.sin(phiRad);
  const majorAxisBearingDeg = norm360(90 - phiRad / RAD);

  const nVerts = Math.max(8, Math.min(96, Math.trunc(polygonVertices) || DEFAULT_POLYGON_VERTICES));
  const uncertaintyPolygon = [];
  const geoJsonRing = [];

  for (let i = 0; i < nVerts; i++) {
    const theta = (2 * Math.PI * i) / nVerts;
    const localMajor = semiMajor95M * Math.cos(theta);
    const localMinor = semiMinor95M * Math.sin(theta);
    const eVert = eastInt + localMajor * cosPhi - localMinor * sinPhi;
    const nVert = northInt + localMajor * sinPhi + localMinor * cosPhi;
    const [vLat, vLon] = frame.toLatLon(eVert, nVert);
    uncertaintyPolygon.push([vLat, vLon]);
    geoJsonRing.push([vLon, vLat]);
  }
  if (geoJsonRing.length > 0) {
    geoJsonRing.push([geoJsonRing[0][0], geoJsonRing[0][1]]);
  }

  return {
    uncertainty1SigmaM: semiMajor1SigmaM,
    uncertainty95M: semiMajor95M,
    uncertaintyRadiusM: semiMajor95M,
    semiMajorM: semiMajor95M,
    semiMinorM: semiMinor95M,
    majorAxisBearingDeg,
    uncertaintyPolygon,
    uncertainty_geo: {
      type: 'Polygon',
      coordinates: [geoJsonRing],
    },
  };
}

function normalizePairArguments(args) {
  if (typeof args[1] === 'number' || typeof args[3] === 'number') {
    const [cam1, bearing1, cam2, bearing2, opts] = args;
    return {
      pose1: extractCameraPose(cam1),
      bearing1: Number.isFinite(bearing1) ? norm360(bearing1) : null,
      sigma1: isPlainObject(cam1) && Number.isFinite(cam1.sigmaBearingDeg) ? cam1.sigmaBearingDeg : null,
      pose2: extractCameraPose(cam2),
      bearing2: Number.isFinite(bearing2) ? norm360(bearing2) : null,
      sigma2: isPlainObject(cam2) && Number.isFinite(cam2.sigmaBearingDeg) ? cam2.sigmaBearingDeg : null,
      options: isPlainObject(opts) ? opts : {},
    };
  }

  const [obs1, obs2, opts] = args;
  const pose1 = extractCameraPose(obs1);
  const pose2 = extractCameraPose(obs2);
  const rawB1 = isPlainObject(obs1) ? (obs1.bearingDeg ?? obs1.bearing_deg ?? obs1.bearing) : null;
  const rawB2 = isPlainObject(obs2) ? (obs2.bearingDeg ?? obs2.bearing_deg ?? obs2.bearing) : null;
  const b1 = Number.isFinite(rawB1)
    ? norm360(rawB1)
    : (pose1 && isPlainObject(obs1) ? bearingFromTrackBbox(obs1.track ?? obs1.bbox ?? obs1, pose1) : null);
  const b2 = Number.isFinite(rawB2)
    ? norm360(rawB2)
    : (pose2 && isPlainObject(obs2) ? bearingFromTrackBbox(obs2.track ?? obs2.bbox ?? obs2, pose2) : null);

  return {
    pose1,
    bearing1: b1,
    sigma1: isPlainObject(obs1) && Number.isFinite(obs1.sigmaBearingDeg) ? obs1.sigmaBearingDeg : null,
    pose2,
    bearing2: b2,
    sigma2: isPlainObject(obs2) && Number.isFinite(obs2.sigmaBearingDeg) ? obs2.sigmaBearingDeg : null,
    options: isPlainObject(opts) ? opts : {},
  };
}

export function triangulateBearingPair(...args) {
  const { pose1, bearing1, sigma1, pose2, bearing2, sigma2, options } = normalizePairArguments(args);
  if (!pose1 || !pose2 || bearing1 === null || bearing2 === null) return null;

  const minBaselineM = Number.isFinite(options.minBaselineM) && options.minBaselineM > 0
    ? options.minBaselineM
    : DEFAULT_MIN_BASELINE_M;
  const maxRangeM = Number.isFinite(options.maxRangeM) && options.maxRangeM > 0
    ? options.maxRangeM
    : DEFAULT_MAX_RANGE_M;
  const minRayAngleDeg = Number.isFinite(options.minRayAngleDeg) && options.minRayAngleDeg > 0
    ? options.minRayAngleDeg
    : DEFAULT_MIN_RAY_ANGLE_DEG;
  const maxRayAngleDeg = Number.isFinite(options.maxRayAngleDeg) && options.maxRayAngleDeg < 180
    ? options.maxRayAngleDeg
    : DEFAULT_MAX_RAY_ANGLE_DEG;
  const defaultSigmaDeg = Number.isFinite(options.sigmaBearingDeg) && options.sigmaBearingDeg > 0 && options.sigmaBearingDeg < 90
    ? options.sigmaBearingDeg
    : DEFAULT_SIGMA_BEARING_DEG;
  const sigma1Deg = sigma1 !== null && sigma1 > 0 && sigma1 < 90 ? sigma1 : defaultSigmaDeg;
  const sigma2Deg = sigma2 !== null && sigma2 > 0 && sigma2 < 90 ? sigma2 : defaultSigmaDeg;

  if (options.enforceFov === true) {
    if (shortestAngleDiffDeg(bearing1, pose1.heading_deg) > 0.5 * pose1.hfov_deg + 1e-6) return null;
    if (shortestAngleDiffDeg(bearing2, pose2.heading_deg) > 0.5 * pose2.hfov_deg + 1e-6) return null;
  }

  const dLonMid = ((pose2.lon - pose1.lon + 540) % 360) - 180;
  const midLat = 0.5 * (pose1.lat + pose2.lat);
  const midLon = normLon180(pose1.lon + 0.5 * dLonMid);
  if (Math.abs(midLat) > 89.999) return null;

  const frame = createEnuFrame(midLat, midLon);
  const [e1, n1] = frame.toEnu(pose1.lat, pose1.lon);
  const [e2, n2] = frame.toEnu(pose2.lat, pose2.lon);
  const be = e2 - e1;
  const bn = n2 - n1;
  const baselineM = Math.hypot(be, bn);

  if (!Number.isFinite(baselineM) || baselineM < minBaselineM) return null;

  const b1Rad = bearing1 * RAD;
  const b2Rad = bearing2 * RAD;
  const u1e = Math.sin(b1Rad);
  const u1n = Math.cos(b1Rad);
  const u2e = Math.sin(b2Rad);
  const u2n = Math.cos(b2Rad);

  const cross = u1e * u2n - u1n * u2e;
  const dot = Math.max(-1, Math.min(1, u1e * u2e + u1n * u2n));
  const interRayAngleDeg = Math.atan2(Math.abs(cross), dot) / RAD;

  if (
    !Number.isFinite(interRayAngleDeg) ||
    Math.abs(cross) < 1e-9 ||
    interRayAngleDeg < minRayAngleDeg ||
    interRayAngleDeg > maxRayAngleDeg
  ) {
    return null;
  }

  // Solve p1 + t1 * u1 = p2 + t2 * u2  =>  t1 * u1 - t2 * u2 = p2 - p1 = b.
  const t1 = (be * u2n - bn * u2e) / cross;
  const t2 = (be * u1n - bn * u1e) / cross;

  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 <= 0 || t2 <= 0) return null;
  if (t1 > maxRangeM || t2 > maxRangeM) return null;

  const eastInt = 0.5 * ((e1 + t1 * u1e) + (e2 + t2 * u2e));
  const northInt = 0.5 * ((n1 + t1 * u1n) + (n2 + t2 * u2n));
  const [lat, lon] = frame.toLatLon(eastInt, northInt);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }

  // First-order Jacobian covariance propagation:
  // dx/db1 = -(t1 / cross) * u2,  dx/db2 = +(t2 / cross) * u1.
  const s1 = (t1 * sigma1Deg * RAD) / cross;
  const s2 = (t2 * sigma2Deg * RAD) / cross;
  const s1Sq = s1 * s1;
  const s2Sq = s2 * s2;

  const sigmaEE = s1Sq * u2e * u2e + s2Sq * u1e * u1e;
  const sigmaEN = s1Sq * u2e * u2n + s2Sq * u1e * u1n;
  const sigmaNN = s1Sq * u2n * u2n + s2Sq * u1n * u1n;

  const ellipse = decomposeCovarianceEllipse(
    frame,
    eastInt,
    northInt,
    sigmaEE,
    sigmaEN,
    sigmaNN,
    options.polygonVertices
  );

  return {
    advisory: true,
    geo_basis: STEREO_GEO_BASIS,
    lat,
    lon,
    target_geo: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    baseline_m: baselineM,
    baselineM,
    inter_ray_angle_deg: interRayAngleDeg,
    interRayAngleDeg,
    range1_m: t1,
    range2_m: t2,
    ranges_m: [t1, t2],
    bearing1_deg: bearing1,
    bearing2_deg: bearing2,
    sigma_bearing_deg: 0.5 * (sigma1Deg + sigma2Deg),
    covarianceEnu: { ee: sigmaEE, en: sigmaEN, nn: sigmaNN },
    ...ellipse,
    disclaimer: STEREO_DISCLAIMER,
  };
}

function normalizeTrackClass(raw) {
  const cls = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (cls === 'rejected' || cls === 'debris') return null;
  if (cls === 'drone' || cls === 'bird') return cls;
  return 'unknown';
}

function resolveCompatibleClass(clsA, clsB) {
  if (!clsA || !clsB) return null;
  if ((clsA === 'bird' && clsB === 'drone') || (clsA === 'drone' && clsB === 'bird')) {
    return null;
  }
  if (clsA === clsB) return { resolved: clsA, exact: true };
  const specific = clsA !== 'unknown' ? clsA : clsB;
  return { resolved: specific, exact: false };
}

function extractCameraTracks(stateObj, pose) {
  const rawTracks = Array.isArray(stateObj?.tracks) ? stateObj.tracks : [];
  const extracted = [];

  for (let idx = 0; idx < rawTracks.length; idx++) {
    const item = rawTracks[idx];
    if (!isPlainObject(item)) continue;
    const trackClass = normalizeTrackClass(item.classification ?? item.type ?? item.cls);
    if (!trackClass) continue;

    const center = extractNormalizedCenter(item);
    let bearingDeg = null;
    let elevationDeg = null;
    if (center) {
      bearingDeg = pinholeBearingFromX(center.xNorm, pose.heading_deg, pose.hfov_deg);
      if (center.yNorm !== null && Number.isFinite(pose.pitch_deg)) {
        elevationDeg = pinholeElevationFromY(center.yNorm, pose.pitch_deg, pose.hfov_deg);
      }
    } else if (Number.isFinite(item.bearing_deg ?? item.bearingDeg)) {
      bearingDeg = norm360(item.bearing_deg ?? item.bearingDeg);
      if (Number.isFinite(item.elevation_deg ?? item.elevationDeg)) {
        elevationDeg = item.elevation_deg ?? item.elevationDeg;
      }
    }
    if (bearingDeg === null || !Number.isFinite(bearingDeg)) continue;

    const confRaw = item.confidence;
    const confidence = Number.isFinite(confRaw) && confRaw >= 0 && confRaw <= 1 ? confRaw : 0.7;
    extracted.push({
      trackId: item.id !== undefined && item.id !== null ? String(item.id) : `idx-${idx}`,
      trackClass,
      bearingDeg,
      elevationDeg,
      confidence,
    });
  }

  return extracted;
}

function normalizeCameraSnapshot(entry, defaultAirport) {
  if (!isPlainObject(entry)) return null;
  const cameraId = typeof entry.cameraId === 'string' && entry.cameraId.trim() ? entry.cameraId.trim() : null;
  if (!cameraId) return null;

  if (entry.demo === true || entry.online === false) return null;
  if (entry.sourceMode === 'demo' || entry.sourceMode === 'upload') return null;
  if (entry.source !== undefined && entry.source !== 'live') return null;
  if (entry.mode !== undefined && entry.mode !== 'server' && entry.mode !== 'live') return null;

  let airport = null;
  if (entry.airport !== undefined && entry.airport !== null) {
    if (typeof entry.airport !== 'string' || !entry.airport.trim()) return null;
    airport = entry.airport.trim();
  } else if (typeof defaultAirport === 'string' && defaultAirport.trim()) {
    airport = defaultAirport.trim();
  }

  const pose = extractCameraPose(entry);
  if (!pose) return null;

  const stateObj = isPlainObject(entry.state) ? entry.state : entry;
  if (stateObj.learning === true || stateObj.shake === true || stateObj.overflow === true) return null;

  const rawTs = entry.updatedAt ?? entry.at ?? entry.receivedAt ?? entry.timestamp ?? null;
  const updatedAt = rawTs !== null && Number.isFinite(rawTs) ? Number(rawTs) : null;

  const labelRaw = entry.cameraLabel;
  const cameraLabel = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 60) : cameraId;

  const obsList = extractCameraTracks(stateObj, pose);
  return {
    airport,
    cameraId,
    cameraLabel,
    pose,
    updatedAt,
    obsList,
  };
}

function fuseMultiCameraCluster(observations, options) {
  if (observations.length === 2) {
    const [o1, o2] = observations;
    const pair = triangulateBearingPair(o1.cam.pose, o1.obs.bearingDeg, o2.cam.pose, o2.obs.bearingDeg, options);
    if (!pair) return null;
    return {
      ...pair,
      ranges: [pair.range1_m, pair.range2_m],
      residualDeg: 0,
      residualM: 0,
    };
  }

  const maxRangeM = Number.isFinite(options.maxRangeM) && options.maxRangeM > 0
    ? options.maxRangeM
    : DEFAULT_MAX_RANGE_M;
  const sigmaDeg = Number.isFinite(options.sigmaBearingDeg) && options.sigmaBearingDeg > 0 && options.sigmaBearingDeg < 90
    ? options.sigmaBearingDeg
    : DEFAULT_SIGMA_BEARING_DEG;
  const sigmaRad = sigmaDeg * RAD;

  // Tangent ENU around centroid of all contributing cameras.
  const lat0 = observations.reduce((s, o) => s + o.cam.pose.lat, 0) / observations.length;
  const baseLon = observations[0].cam.pose.lon;
  const meanDLon = observations.reduce((s, o) => s + (((o.cam.pose.lon - baseLon + 540) % 360) - 180), 0) / observations.length;
  const lon0 = normLon180(baseLon + meanDLon);
  const frame = createEnuFrame(lat0, lon0);

  const rays = observations.map(({ cam, obs }) => {
    const [pe, pn] = frame.toEnu(cam.pose.lat, cam.pose.lon);
    const bRad = obs.bearingDeg * RAD;
    const ue = Math.sin(bRad);
    const un = Math.cos(bRad);
    // Unit normal perpendicular to ray: n = [cos(b), -sin(b)].
    const ne = un;
    const nn = -ue;
    return { pe, pn, ue, un, ne, nn, bearingDeg: obs.bearingDeg };
  });

  // Two-pass weighted perpendicular-distance least squares (Gauss-Newton MLE).
  let weights = rays.map(() => 1);
  let eastInt = 0;
  let northInt = 0;

  for (let pass = 0; pass < 2; pass++) {
    let aEE = 0;
    let aEN = 0;
    let aNN = 0;
    let bE = 0;
    let bN = 0;
    for (let i = 0; i < rays.length; i++) {
      const r = rays[i];
      const w = weights[i];
      const rhs = r.ne * r.pe + r.nn * r.pn;
      aEE += w * r.ne * r.ne;
      aEN += w * r.ne * r.nn;
      aNN += w * r.nn * r.nn;
      bE += w * r.ne * rhs;
      bN += w * r.nn * rhs;
    }
    const det = aEE * aNN - aEN * aEN;
    if (!Number.isFinite(det) || det <= 1e-12) return null;
    eastInt = (aNN * bE - aEN * bN) / det;
    northInt = (-aEN * bE + aEE * bN) / det;

    weights = rays.map(r => {
      const dist = Math.max(10, Math.hypot(eastInt - r.pe, northInt - r.pn));
      const s = dist * sigmaRad;
      return 1 / (s * s);
    });
  }

  const ranges = [];
  let sumSqDeg = 0;
  let sumSqM = 0;
  let infoEE = 0;
  let infoEN = 0;
  let infoNN = 0;

  for (const r of rays) {
    const de = eastInt - r.pe;
    const dn = northInt - r.pn;
    const along = de * r.ue + dn * r.un;
    if (!Number.isFinite(along) || along <= 0 || along > maxRangeM) return null;
    const perp = de * r.ne + dn * r.nn;
    const fitBearing = norm360(Math.atan2(de, dn) / RAD);
    const angErr = shortestAngleDiffDeg(fitBearing, r.bearingDeg);
    ranges.push(along);
    sumSqM += perp * perp;
    sumSqDeg += angErr * angErr;

    const s = Math.max(1, along) * sigmaRad;
    const invVar = 1 / (s * s);
    infoEE += invVar * r.ne * r.ne;
    infoEN += invVar * r.ne * r.nn;
    infoNN += invVar * r.nn * r.nn;
  }

  const infoDet = infoEE * infoNN - infoEN * infoEN;
  if (!Number.isFinite(infoDet) || infoDet <= 1e-12) return null;
  const sigmaEE = infoNN / infoDet;
  const sigmaEN = -infoEN / infoDet;
  const sigmaNN = infoEE / infoDet;

  let maxBaselineM = 0;
  let bestInterRayAngleDeg = 0;
  for (let i = 0; i < rays.length; i++) {
    for (let j = i + 1; j < rays.length; j++) {
      const base = Math.hypot(rays[j].pe - rays[i].pe, rays[j].pn - rays[i].pn);
      if (base > maxBaselineM) maxBaselineM = base;
      const cross = rays[i].ue * rays[j].un - rays[i].un * rays[j].ue;
      const dot = Math.max(-1, Math.min(1, rays[i].ue * rays[j].ue + rays[i].un * rays[j].un));
      const angle = Math.atan2(Math.abs(cross), dot) / RAD;
      const sinScore = Math.sin(angle * RAD);
      if (sinScore > Math.sin(bestInterRayAngleDeg * RAD)) bestInterRayAngleDeg = angle;
    }
  }

  const [lat, lon] = frame.toLatLon(eastInt, northInt);
  const ellipse = decomposeCovarianceEllipse(
    frame,
    eastInt,
    northInt,
    sigmaEE,
    sigmaEN,
    sigmaNN,
    options.polygonVertices
  );

  return {
    advisory: true,
    geo_basis: STEREO_GEO_BASIS,
    lat,
    lon,
    target_geo: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    baseline_m: maxBaselineM,
    baselineM: maxBaselineM,
    inter_ray_angle_deg: bestInterRayAngleDeg,
    interRayAngleDeg: bestInterRayAngleDeg,
    range1_m: ranges[0],
    range2_m: ranges[1],
    ranges_m: ranges,
    ranges,
    bearing1_deg: rays[0].bearingDeg,
    bearing2_deg: rays[1].bearingDeg,
    sigma_bearing_deg: sigmaDeg,
    covarianceEnu: { ee: sigmaEE, en: sigmaEN, nn: sigmaNN },
    ...ellipse,
    residualDeg: Math.sqrt(sumSqDeg / rays.length),
    residualM: Math.sqrt(sumSqM / rays.length),
    disclaimer: STEREO_DISCLAIMER,
  };
}

function correlateSameAirportGroup(cams, airport, refNow, options) {
  const maxSkewMs = Number.isFinite(options.maxSkewMs) && options.maxSkewMs > 0
    ? options.maxSkewMs
    : DEFAULT_MAX_SKEW_MS;
  const sigmaDeg = Number.isFinite(options.sigmaBearingDeg) && options.sigmaBearingDeg > 0 && options.sigmaBearingDeg < 90
    ? options.sigmaBearingDeg
    : DEFAULT_SIGMA_BEARING_DEG;

  const freshCams = cams.filter(cam => {
    if (cam.updatedAt === null) return !options.hasExplicitNow;
    if (refNow === null) return true;
    return refNow - cam.updatedAt <= maxSkewMs && cam.updatedAt - refNow <= maxSkewMs;
  });

  const updatedAt = refNow !== null ? refNow : Date.now();
  if (freshCams.length < 2) {
    return {
      airport,
      updatedAt,
      cameraCount: freshCams.length,
      fixes: [],
      advisory: true,
      geo_basis: STEREO_GEO_BASIS,
    };
  }

  // Generate all valid pairwise intersection hypotheses across distinct cameras.
  const pairs = [];
  for (let i = 0; i < freshCams.length; i++) {
    const camA = freshCams[i];
    for (let j = i + 1; j < freshCams.length; j++) {
      const camB = freshCams[j];
      if (camA.cameraId === camB.cameraId) continue;
      if (camA.airport !== camB.airport) continue;

      const skewMs = camA.updatedAt !== null && camB.updatedAt !== null
        ? Math.abs(camA.updatedAt - camB.updatedAt)
        : 0;
      if (skewMs > maxSkewMs) continue;

      for (const obsA of camA.obsList) {
        for (const obsB of camB.obsList) {
          const compat = resolveCompatibleClass(obsA.trackClass, obsB.trackClass);
          if (!compat) continue;

          const tri = triangulateBearingPair(camA.pose, obsA.bearingDeg, camB.pose, obsB.bearingDeg, options);
          if (!tri) continue;

          // Soft ranking residual: 3D elevation consistency (when available) + normalized uncertainty + skew + class tie-break.
          let elevDiffDeg = 0;
          if (obsA.elevationDeg !== null && obsB.elevationDeg !== null) {
            const hA = tri.range1_m * Math.tan(obsA.elevationDeg * RAD);
            const hB = tri.range2_m * Math.tan(obsB.elevationDeg * RAD);
            const avgRange = Math.max(10, 0.5 * (tri.range1_m + tri.range2_m));
            elevDiffDeg = (Math.abs(hA - hB) / avgRange) / RAD;
          }
          const classPenalty = compat.exact ? 0 : 1.5;
          const geomScore = elevDiffDeg + classPenalty + 0.02 * tri.uncertainty1SigmaM + 0.0005 * skewMs;

          pairs.push({
            camA,
            obsA,
            camB,
            obsB,
            compat,
            tri,
            skewMs,
            elevDiffDeg,
            score: geomScore,
          });
        }
      }
    }
  }

  // Greedy-match lowest angular/spatial residual first.
  pairs.sort((a, b) => a.score - b.score);

  const usedTracks = new Set();
  const trackKey = (cam, obs) => `${cam.cameraId}::${obs.trackId}`;
  const fixes = [];

  for (const seed of pairs) {
    const keyA = trackKey(seed.camA, seed.obsA);
    const keyB = trackKey(seed.camB, seed.obsB);
    if (usedTracks.has(keyA) || usedTracks.has(keyB)) continue;

    const cluster = [
      { cam: seed.camA, obs: seed.obsA },
      { cam: seed.camB, obs: seed.obsB },
    ];
    let resolvedClass = seed.compat.resolved;
    const usedCameraIds = new Set([seed.camA.cameraId, seed.camB.cameraId]);

    // Absorb compatible corroborating tracks from any 3rd+ live camera in the same airport.
    if (freshCams.length > 2) {
      const gateDeg = Math.max(4.0, 2.5 * sigmaDeg);
      for (const extraCam of freshCams) {
        if (usedCameraIds.has(extraCam.cameraId) || extraCam.airport !== seed.camA.airport) continue;
        let bestExtra = null;
        let bestErrDeg = gateDeg;
        for (const extraObs of extraCam.obsList) {
          if (usedTracks.has(trackKey(extraCam, extraObs))) continue;
          const compatWithCluster = resolveCompatibleClass(resolvedClass, extraObs.trackClass);
          if (!compatWithCluster) continue;
          if (extraCam.updatedAt !== null) {
            const exceedsSkew = cluster.some(
              m => m.cam.updatedAt !== null && Math.abs(extraCam.updatedAt - m.cam.updatedAt) > maxSkewMs
            );
            if (exceedsSkew) continue;
          }
          const expectedBearing = bearingBetweenPoints(
            extraCam.pose.lat,
            extraCam.pose.lon,
            seed.tri.lat,
            seed.tri.lon
          );
          const expectedRange = distanceMeters(
            extraCam.pose.lat,
            extraCam.pose.lon,
            seed.tri.lat,
            seed.tri.lon
          );
          const maxRangeM = Number.isFinite(options.maxRangeM) && options.maxRangeM > 0
            ? options.maxRangeM
            : DEFAULT_MAX_RANGE_M;
          if (expectedBearing === null || !Number.isFinite(expectedRange) || expectedRange <= 0 || expectedRange > maxRangeM) {
            continue;
          }
          const angErr = shortestAngleDiffDeg(expectedBearing, extraObs.bearingDeg);
          if (angErr <= bestErrDeg) {
            bestErrDeg = angErr;
            bestExtra = { obs: extraObs, resolved: compatWithCluster.resolved };
          }
        }
        if (bestExtra) {
          cluster.push({ cam: extraCam, obs: bestExtra.obs });
          usedCameraIds.add(extraCam.cameraId);
          resolvedClass = bestExtra.resolved;
        }
      }
    }

    const fused = fuseMultiCameraCluster(cluster, options) || {
      ...seed.tri,
      ranges: [seed.tri.range1_m, seed.tri.range2_m],
      residualDeg: seed.elevDiffDeg,
      residualM: 0,
    };

    for (const member of cluster) {
      usedTracks.add(trackKey(member.cam, member.obs));
    }

    const contributing = cluster
      .map((member, idx) => ({
        cameraId: member.cam.cameraId,
        cameraLabel: member.cam.cameraLabel,
        trackId: member.obs.trackId,
        classification: member.obs.trackClass,
        lat: member.cam.pose.lat,
        lon: member.cam.pose.lon,
        bearing_deg: member.obs.bearingDeg,
        bearingDeg: member.obs.bearingDeg,
        range_m: fused.ranges[idx],
        rangeM: fused.ranges[idx],
        updatedAt: member.cam.updatedAt,
      }))
      .sort((a, b) => a.cameraId.localeCompare(b.cameraId));

    const tsValues = contributing.map(c => c.updatedAt).filter(t => t !== null);
    const fixSkewMs = tsValues.length >= 2 ? Math.max(...tsValues) - Math.min(...tsValues) : 0;
    const fixUpdatedAt = tsValues.length > 0 ? Math.max(...tsValues) : updatedAt;
    const avgConfidence = cluster.reduce((s, m) => s + m.obs.confidence, 0) / cluster.length;
    const fixId = `${airport || 'local'}:${contributing.map(c => `${c.cameraId}#${c.trackId}`).join('+')}`;

    const { ranges: _internalRanges, ...publicGeometry } = fused;
    fixes.push({
      id: fixId,
      airport,
      ...publicGeometry,
      advisory: true,
      geo_basis: STEREO_GEO_BASIS,
      classification: resolvedClass,
      risk: resolvedClass === 'drone' ? 'red' : 'yellow',
      confidence: Math.round(avgConfidence * 1000) / 1000,
      range1_m: contributing[0].range_m,
      range2_m: contributing[1].range_m,
      ranges_m: contributing.map(c => c.range_m),
      cameras: contributing,
      cameraIds: contributing.map(c => c.cameraId),
      cameraLabels: contributing.map(c => c.cameraLabel),
      cameraCount: contributing.length,
      skewMs: fixSkewMs,
      updatedAt: fixUpdatedAt,
      disclaimer: STEREO_DISCLAIMER,
    });
  }

  return {
    airport,
    updatedAt,
    cameraCount: freshCams.length,
    fixes,
    advisory: true,
    geo_basis: STEREO_GEO_BASIS,
  };
}

export function correlateAirportCameras(camerasInput, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const explicitAirport = typeof opts.airport === 'string' && opts.airport.trim() ? opts.airport.trim() : null;
  const hasExplicitNow = typeof opts.now === 'function' || Number.isFinite(opts.now);
  const explicitNowMs = typeof opts.now === 'function'
    ? Number(opts.now())
    : (Number.isFinite(opts.now) ? Number(opts.now) : null);

  if (!camerasInput || (typeof camerasInput[Symbol.iterator] !== 'function' && !Array.isArray(camerasInput))) {
    return {
      airport: explicitAirport,
      updatedAt: Number.isFinite(explicitNowMs) ? explicitNowMs : Date.now(),
      cameraCount: 0,
      fixes: [],
      advisory: true,
      geo_basis: STEREO_GEO_BASIS,
    };
  }

  const rawEntries = Array.isArray(camerasInput) ? camerasInput : [...camerasInput];
  const anyExplicitEntryAirport = rawEntries.some(
    e => isPlainObject(e) && typeof e.airport === 'string' && e.airport.trim().length > 0
  );

  const dedupedByCam = new Map();
  for (const entry of rawEntries) {
    const normalized = normalizeCameraSnapshot(entry, explicitAirport);
    if (!normalized) continue;

    // Strict airport isolation: never coerce or mix different airports.
    if (explicitAirport !== null && normalized.airport !== explicitAirport) continue;
    if (explicitAirport === null && anyExplicitEntryAirport && normalized.airport === null) continue;

    const prior = dedupedByCam.get(normalized.cameraId);
    if (!prior || (normalized.updatedAt ?? -Infinity) >= (prior.updatedAt ?? -Infinity)) {
      dedupedByCam.set(normalized.cameraId, normalized);
    }
  }

  const validCams = [...dedupedByCam.values()];
  if (explicitAirport !== null) {
    const timestamps = validCams.map(c => c.updatedAt).filter(t => t !== null);
    const refNow = Number.isFinite(explicitNowMs)
      ? explicitNowMs
      : (timestamps.length > 0 ? Math.max(...timestamps) : null);
    return correlateSameAirportGroup(validCams, explicitAirport, refNow, { ...opts, hasExplicitNow });
  }

  // Group strictly by airport; heterogeneous airport batches NEVER cross-correlate.
  const byAirport = new Map();
  for (const cam of validCams) {
    const key = cam.airport ?? '';
    if (!byAirport.has(key)) byAirport.set(key, []);
    byAirport.get(key).push(cam);
  }

  if (byAirport.size === 0) {
    return {
      airport: null,
      updatedAt: Number.isFinite(explicitNowMs) ? explicitNowMs : Date.now(),
      cameraCount: 0,
      fixes: [],
      advisory: true,
      geo_basis: STEREO_GEO_BASIS,
    };
  }

  if (byAirport.size === 1) {
    const [[airportKey, groupCams]] = byAirport.entries();
    const timestamps = groupCams.map(c => c.updatedAt).filter(t => t !== null);
    const refNow = Number.isFinite(explicitNowMs)
      ? explicitNowMs
      : (timestamps.length > 0 ? Math.max(...timestamps) : null);
    return correlateSameAirportGroup(groupCams, airportKey || null, refNow, { ...opts, hasExplicitNow });
  }

  // Multiple airports supplied without an explicit airport selector: correlate strictly inside
  // each airport partition in complete isolation (cross-airport pairs are impossible).
  const allFixes = [];
  let totalEligibleCameras = 0;
  for (const [airportKey, groupCams] of byAirport.entries()) {
    if (!airportKey) continue;
    const timestamps = groupCams.map(c => c.updatedAt).filter(t => t !== null);
    const refNow = Number.isFinite(explicitNowMs)
      ? explicitNowMs
      : (timestamps.length > 0 ? Math.max(...timestamps) : null);
    const sub = correlateSameAirportGroup(groupCams, airportKey, refNow, { ...opts, hasExplicitNow });
    totalEligibleCameras += sub.cameraCount;
    allFixes.push(...sub.fixes);
  }

  return {
    airport: null,
    updatedAt: Number.isFinite(explicitNowMs) ? explicitNowMs : Date.now(),
    cameraCount: totalEligibleCameras,
    fixes: allFixes,
    advisory: true,
    geo_basis: STEREO_GEO_BASIS,
  };
}

export function createStereoCorrelator({
  maxSkewMs = DEFAULT_MAX_SKEW_MS,
  maxRangeM = DEFAULT_MAX_RANGE_M,
  minBaselineM = DEFAULT_MIN_BASELINE_M,
  sigmaBearingDeg = DEFAULT_SIGMA_BEARING_DEG,
  minRayAngleDeg = DEFAULT_MIN_RAY_ANGLE_DEG,
  maxRayAngleDeg = DEFAULT_MAX_RAY_ANGLE_DEG,
  now = Date.now,
} = {}) {
  const entries = new Map(); // cameraId -> record
  const clock = typeof now === 'function' ? now : Date.now;

  const corrOptions = () => ({
    maxSkewMs,
    maxRangeM,
    minBaselineM,
    sigmaBearingDeg,
    minRayAngleDeg,
    maxRayAngleDeg,
    now: clock,
  });

  function emptyPayload(airport = null) {
    return {
      airport: typeof airport === 'string' && airport.trim() ? airport.trim() : null,
      updatedAt: Number(clock()),
      cameraCount: 0,
      fixes: [],
      advisory: true,
      geo_basis: STEREO_GEO_BASIS,
    };
  }

  function pruneStale(atMs = Number(clock())) {
    for (const [camId, rec] of entries.entries()) {
      if (rec.updatedAt !== null && atMs - rec.updatedAt > maxSkewMs) {
        rec.state = null;
        rec.updatedAt = null;
      }
      if (!rec.pose && rec.state === null) {
        entries.delete(camId);
      }
    }
  }

  function correlate(airport) {
    const cleanAirport = typeof airport === 'string' && airport.trim() ? airport.trim() : null;
    const currentNow = Number(clock());
    pruneStale(currentNow);
    if (!cleanAirport) return emptyPayload(null);

    const snapshots = [];
    for (const rec of entries.values()) {
      if (rec.airport !== cleanAirport) continue;
      if (rec.source !== 'live' || !rec.online || !rec.pose || !rec.state || rec.updatedAt === null) continue;
      snapshots.push({
        airport: rec.airport,
        cameraId: rec.cameraId,
        cameraLabel: rec.cameraLabel,
        streamId: rec.streamId,
        source: 'live',
        camera: rec.pose,
        state: rec.state,
        updatedAt: rec.updatedAt,
      });
    }

    return correlateAirportCameras(snapshots, {
      ...corrOptions(),
      airport: cleanAirport,
      now: currentNow,
    });
  }

  function configureCamera(input) {
    if (!isPlainObject(input)) return false;
    const cameraId = typeof input.cameraId === 'string' && input.cameraId.trim() ? input.cameraId.trim() : null;
    const airport = typeof input.airport === 'string' && input.airport.trim() ? input.airport.trim() : null;
    if (!cameraId || !airport) return false;

    if (input.demo === true || input.sourceMode === 'upload' || input.sourceMode === 'demo') {
      entries.delete(cameraId);
      return false;
    }
    if (input.source !== undefined && input.source !== 'live') {
      entries.delete(cameraId);
      return false;
    }

    const pose = extractCameraPose(input);
    if (!pose) {
      entries.delete(cameraId);
      return false;
    }

    const prior = entries.get(cameraId);
    const streamChanged = input.streamId !== undefined && prior && prior.streamId !== input.streamId;
    const airportChanged = prior && prior.airport !== airport;
    const labelRaw = input.cameraLabel ?? prior?.cameraLabel ?? cameraId;
    const cameraLabel = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 60) : cameraId;

    entries.set(cameraId, {
      airport,
      cameraId,
      cameraLabel,
      streamId: input.streamId ?? prior?.streamId ?? null,
      source: 'live',
      online: input.online !== undefined ? Boolean(input.online) : true,
      pose,
      state: streamChanged || airportChanged ? null : (prior?.state ?? null),
      updatedAt: streamChanged || airportChanged ? null : (prior?.updatedAt ?? null),
    });
    return true;
  }

  function updateCamera(input) {
    if (!isPlainObject(input)) return emptyPayload(null);
    const cameraId = typeof input.cameraId === 'string' && input.cameraId.trim() ? input.cameraId.trim() : null;
    const prior = cameraId ? entries.get(cameraId) : null;
    const airportRaw = input.airport !== undefined ? input.airport : prior?.airport;
    const airport = typeof airportRaw === 'string' && airportRaw.trim() ? airportRaw.trim() : null;

    if (!cameraId || !airport) return emptyPayload(airport);

    if (
      input.demo === true ||
      input.online === false ||
      input.sourceMode === 'upload' ||
      input.sourceMode === 'demo' ||
      (input.source !== undefined && input.source !== 'live') ||
      (input.mode !== undefined && input.mode !== 'server' && input.mode !== 'live')
    ) {
      if (prior) {
        prior.state = null;
        prior.updatedAt = null;
        if (input.online === false || (input.source !== undefined && input.source !== 'live')) {
          entries.delete(cameraId);
        }
      }
      return correlate(airport);
    }

    const hasPoseField = input.camera !== undefined || input.config !== undefined || input.lat !== undefined;
    let pose = prior && prior.airport === airport ? prior.pose : null;
    if (hasPoseField) {
      pose = extractCameraPose(input);
      if (!pose) {
        entries.delete(cameraId);
        return correlate(airport);
      }
    }
    if (!pose) return correlate(airport);

    const labelRaw = input.cameraLabel ?? prior?.cameraLabel ?? cameraId;
    const cameraLabel = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 60) : cameraId;

    const rawState = isPlainObject(input.state)
      ? input.state
      : (Array.isArray(input.tracks) ? { tracks: input.tracks, learning: input.learning, shake: input.shake, overflow: input.overflow } : null);

    const tsCandidate = input.updatedAt ?? input.at ?? input.receivedAt ?? input.timestamp;
    const currentNow = Number(clock());
    const updatedAt = Number.isFinite(tsCandidate) ? Number(tsCandidate) : currentNow;

    let usableState = prior && prior.airport === airport ? prior.state : null;
    let usableTs = prior && prior.airport === airport ? prior.updatedAt : null;

    if (input.state === null) {
      usableState = null;
      usableTs = null;
    } else if (rawState) {
      if (rawState.learning === true || rawState.shake === true || rawState.overflow === true) {
        usableState = null;
        usableTs = null;
      } else {
        usableState = rawState;
        usableTs = updatedAt;
      }
    }

    entries.set(cameraId, {
      airport,
      cameraId,
      cameraLabel,
      streamId: input.streamId ?? prior?.streamId ?? null,
      source: 'live',
      online: true,
      pose,
      state: usableState,
      updatedAt: usableTs,
    });

    return correlate(airport);
  }

  function setCameraStatus(cameraId, status = {}) {
    if (typeof cameraId !== 'string' || !cameraId.trim()) return false;
    const rec = entries.get(cameraId.trim());
    if (!rec) return false;
    if (status?.online === false) {
      entries.delete(rec.cameraId);
      return true;
    }
    if (status?.mode !== undefined && status.mode !== 'server' && status.mode !== 'live') {
      rec.state = null;
      rec.updatedAt = null;
      return true;
    }
    return true;
  }

  function removeCamera(cameraId) {
    if (typeof cameraId !== 'string' || !cameraId.trim()) return false;
    return entries.delete(cameraId.trim());
  }

  function clearAirport(airport) {
    if (typeof airport !== 'string' || !airport.trim()) return 0;
    const target = airport.trim();
    let removed = 0;
    for (const [camId, rec] of entries.entries()) {
      if (rec.airport === target) {
        entries.delete(camId);
        removed++;
      }
    }
    return removed;
  }

  function clear() {
    entries.clear();
  }

  return {
    configureCamera,
    updateCamera,
    updateState: updateCamera,
    record: updateCamera,
    setCameraStatus,
    removeCamera,
    clearAirport,
    correlate,
    prune: () => pruneStale(Number(clock())),
    sweep: () => pruneStale(Number(clock())),
    clear,
    destroy: clear,
    get size() {
      return entries.size;
    },
  };
}

export const createStereoRegistry = createStereoCorrelator;
