'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const cjsStereo = require('../stereo-triangulation');

const RAD = Math.PI / 180;
const EARTH_R = 6371000;

// Independent spherical great-circle helpers (matching PRANAV/public/detection/src/geo.js)
// to cross-check stereo recovery without sharing implementation code.
function sphericalDestination(lat, lon, bearingDeg, meters) {
  const d = meters / EARTH_R;
  const b = bearingDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2)
  );
  return {
    lat: p2 / RAD,
    lon: (((l2 / RAD) + 540) % 360) - 180,
  };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function sphericalForwardAzimuthDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

// Inverse pinhole projection: given a target compass bearing and camera heading/hfov,
// produce a normalized bbox { x, y, w, h } whose center projects to that exact bearing.
function bboxForBearing(targetBearingDeg, pose, boxW = 0.04, boxH = 0.04, yCenter = 0.45) {
  const f = 0.5 / Math.tan((pose.hfov_deg * RAD) / 2);
  const deltaDeg = ((targetBearingDeg - pose.heading_deg + 540) % 360) - 180;
  const xCenter = 0.5 + f * Math.tan(deltaDeg * RAD);
  assert.ok(xCenter >= boxW / 2 && xCenter <= 1 - boxW / 2, `Target bearing ${targetBearingDeg} outside camera FOV`);
  return {
    x: xCenter - boxW / 2,
    y: yCenter - boxH / 2,
    w: boxW,
    h: boxH,
  };
}

// Princeton Airport (39N / KPCT) reference coordinates: 40.3990, -74.6589
const KPCT = { lat: 40.3990, lon: -74.6589 };

function princetonCameraPair(baselineM = 250) {
  const westPt = sphericalDestination(KPCT.lat, KPCT.lon, 270, baselineM / 2);
  const eastPt = sphericalDestination(KPCT.lat, KPCT.lon, 90, baselineM / 2);
  const camWest = {
    lat: westPt.lat,
    lon: westPt.lon,
    heading_deg: 25,
    hfov_deg: 78,
    pitch_deg: 8,
  };
  const camEast = {
    lat: eastPt.lat,
    lon: eastPt.lon,
    heading_deg: 335,
    hfov_deg: 78,
    pitch_deg: 8,
  };
  return { camWest, camEast };
}

describe('Stereo triangulation math & synthetic ground-truth recovery', () => {
  test('recovers synthetic target near Princeton Airport (40.3990, -74.6589) within < 2 meters from 250m camera baseline', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const baselineCheck = haversineMeters(camWest.lat, camWest.lon, camEast.lat, camEast.lon);
    assert.ok(Math.abs(baselineCheck - 250) < 1.0, `Expected ~250m baseline, got ${baselineCheck}`);

    // Place ground-truth drone 360m NNE of Princeton Airport midpoint.
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 12, 360);

    // 1. Test using independent spherical great-circle bearings.
    const b1Spherical = sphericalForwardAzimuthDeg(camWest.lat, camWest.lon, truth.lat, truth.lon);
    const b2Spherical = sphericalForwardAzimuthDeg(camEast.lat, camEast.lon, truth.lat, truth.lon);

    const fixSpherical = cjsStereo.triangulateBearingPair(camWest, b1Spherical, camEast, b2Spherical, {
      sigmaBearingDeg: 2.0,
    });
    assert.ok(fixSpherical, 'Expected valid stereo fix');
    assert.equal(fixSpherical.advisory, true);
    assert.equal(fixSpherical.geo_basis, 'stereo_bearing_intersection');
    assert.equal(fixSpherical.disclaimer, 'Advisory 2-camera bearing intersection — not radar or clearance');

    const errSphericalM = haversineMeters(truth.lat, truth.lon, fixSpherical.lat, fixSpherical.lon);
    assert.ok(
      errSphericalM < 2.0,
      `Expected recovered position within < 2m of ground truth, got ${errSphericalM.toFixed(4)}m`
    );

    // 2. Test using exact WGS-84 tangent bearings.
    const b1Wgs = cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon);
    const b2Wgs = cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon);
    const fixWgs = cjsStereo.triangulateBearingPair(camWest, b1Wgs, camEast, b2Wgs);
    assert.ok(fixWgs);
    const errWgsM = haversineMeters(truth.lat, truth.lon, fixWgs.lat, fixWgs.lon);
    assert.ok(errWgsM < 0.05, `Expected sub-5cm WGS-84 self-consistency, got ${errWgsM.toFixed(5)}m`);

    // Validate uncertainty ellipse & GeoJSON outputs.
    assert.ok(Math.abs(fixSpherical.baseline_m - 250) < 1.5);
    assert.ok(fixSpherical.range1_m > 300 && fixSpherical.range1_m < 450);
    assert.ok(fixSpherical.range2_m > 300 && fixSpherical.range2_m < 450);
    assert.ok(fixSpherical.uncertaintyRadiusM > 5 && fixSpherical.uncertaintyRadiusM < 120);
    assert.ok(fixSpherical.uncertainty95M > fixSpherical.uncertainty1SigmaM);
    assert.equal(fixSpherical.uncertaintyPolygon.length, 24);
    assert.equal(fixSpherical.uncertainty_geo.type, 'Polygon');
    assert.equal(fixSpherical.uncertainty_geo.coordinates[0].length, 25);
    assert.deepEqual(
      fixSpherical.uncertainty_geo.coordinates[0][0],
      fixSpherical.uncertainty_geo.coordinates[0][24],
      'GeoJSON ring must be closed'
    );
    assert.deepEqual(fixSpherical.target_geo, {
      type: 'Point',
      coordinates: [fixSpherical.lon, fixSpherical.lat],
    });
  });

  test('end-to-end pinhole bbox -> bearingFromTrackBbox -> correlateAirportCameras recovers ground truth within < 2m', async () => {
    const geo = await import('../public/detection/src/geo.js');
    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 4, 320);

    const bWest = cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon);
    const bEast = cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon);
    const boxWest = bboxForBearing(bWest, camWest);
    const boxEast = bboxForBearing(bEast, camEast);

    // Verify exact parity with PRANAV/public/detection/src/geo.js bearingFromX.
    const xCenterWest = boxWest.x + boxWest.w / 2;
    assert.ok(
      Math.abs(
        cjsStereo.bearingFromTrackBbox(boxWest, camWest) -
        geo.bearingFromX(xCenterWest, camWest.heading_deg, camWest.hfov_deg)
      ) < 1e-12
    );

    const result = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'cam-west',
        cameraLabel: 'Runway 10 West',
        source: 'live',
        camera: camWest,
        updatedAt: 50_000,
        state: {
          risk: 'red',
          learning: false,
          shake: false,
          tracks: [{ id: 11, bbox: boxWest, classification: 'drone', confidence: 0.92 }],
        },
      },
      {
        airport: 'KPCT',
        cameraId: 'cam-east',
        cameraLabel: 'Runway 28 East',
        source: 'live',
        camera: camEast,
        updatedAt: 50_120,
        state: {
          risk: 'red',
          learning: false,
          shake: false,
          tracks: [{ id: 27, bbox: boxEast, classification: 'drone', confidence: 0.88 }],
        },
      },
    ]);

    assert.equal(result.airport, 'KPCT');
    assert.equal(result.cameraCount, 2);
    assert.equal(result.advisory, true);
    assert.equal(result.geo_basis, 'stereo_bearing_intersection');
    assert.equal(result.fixes.length, 1);

    const fix = result.fixes[0];
    assert.equal(fix.advisory, true);
    assert.equal(fix.geo_basis, 'stereo_bearing_intersection');
    assert.equal(fix.classification, 'drone');
    assert.equal(fix.cameras.length, 2);
    assert.equal(fix.skewMs, 120);

    const errM = haversineMeters(truth.lat, truth.lon, fix.lat, fix.lon);
    assert.ok(errM < 2.0, `Expected end-to-end bbox triangulation error < 2m, got ${errM.toFixed(4)}m`);
  });

  test('3-camera simultaneous observation fuses all 3 rays into a single tighter fix', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const northWestPt = sphericalDestination(KPCT.lat, KPCT.lon, 315, 220);
    const camThird = {
      lat: northWestPt.lat,
      lon: northWestPt.lon,
      heading_deg: 75,
      hfov_deg: 80,
      pitch_deg: 6,
    };
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 8, 310);

    const makeCam = (id, label, pose, ts) => ({
      airport: 'KPCT',
      cameraId: id,
      cameraLabel: label,
      source: 'live',
      camera: pose,
      updatedAt: ts,
      state: {
        learning: false,
        shake: false,
        tracks: [{
          id: 1,
          bbox: bboxForBearing(cjsStereo.bearingBetweenPoints(pose.lat, pose.lon, truth.lat, truth.lon), pose),
          classification: 'drone',
          confidence: 0.9,
        }],
      },
    });

    const twoCam = cjsStereo.correlateAirportCameras([
      makeCam('cam-1', 'West', camWest, 10_000),
      makeCam('cam-2', 'East', camEast, 10_050),
    ]);
    const threeCam = cjsStereo.correlateAirportCameras([
      makeCam('cam-1', 'West', camWest, 10_000),
      makeCam('cam-2', 'East', camEast, 10_050),
      makeCam('cam-3', 'Northwest', camThird, 10_080),
    ]);

    assert.equal(threeCam.fixes.length, 1);
    assert.equal(threeCam.fixes[0].cameras.length, 3);
    assert.ok(threeCam.fixes[0].uncertaintyRadiusM <= twoCam.fixes[0].uncertaintyRadiusM);
    assert.ok(haversineMeters(truth.lat, truth.lon, threeCam.fixes[0].lat, threeCam.fixes[0].lon) < 2.0);
  });
});

describe('Geometric, temporal, classification, and airport isolation rejections', () => {
  test('rejects invalid camera poses matching corridor-calibration rules', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const badPoses = [
      { ...camWest, lat: 91 },
      { ...camWest, lat: -90.1 },
      { ...camWest, lon: 180.5 },
      { ...camWest, lon: -181 },
      { ...camWest, heading_deg: -1 },
      { ...camWest, heading_deg: 360 },
      { ...camWest, hfov_deg: 0 },
      { ...camWest, hfov_deg: 180 },
      { ...camWest, pitch_deg: 95 },
      null,
      {},
    ];
    for (const bad of badPoses) {
      assert.equal(cjsStereo.isValidCameraPose(bad), false);
      assert.equal(cjsStereo.triangulateBearingPair(bad, 20, camEast, 340), null);
      assert.equal(cjsStereo.bearingFromTrackBbox({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, bad), null);
    }
  });

  test('rejects single camera, co-located cameras (< 8m), divergent rays, parallel rays, head-on rays, and excessive range', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 0, 350);
    const boxWest = bboxForBearing(
      cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon),
      camWest
    );

    // 1. Single camera NEVER produces a 2D fix.
    const singleRes = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'only-cam',
        source: 'live',
        camera: camWest,
        updatedAt: 1000,
        state: { tracks: [{ id: 1, bbox: boxWest, classification: 'drone' }] },
      },
    ]);
    assert.equal(singleRes.cameraCount, 1);
    assert.deepEqual(singleRes.fixes, []);

    // 2. Co-located cameras (< 8m apart, e.g. 4.5m).
    const nearPt = sphericalDestination(camWest.lat, camWest.lon, 90, 4.5);
    const camColocated = { ...camEast, lat: nearPt.lat, lon: nearPt.lon };
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 15, camColocated, 345), null);

    // 3. Divergent rays (pointing away from each other: West points West 270°, East points East 90°).
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 270, camEast, 90), null);
    // Intersection behind one of the cameras.
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 200, camEast, 340), null);

    // 4. Parallel & nearly-parallel rays (inter_ray_angle_deg < 6°).
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 10, camEast, 10), null);
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 12, camEast, 8), null); // 4° < 6°

    // 5. Nearly anti-parallel head-on rays (inter_ray_angle_deg > 174°).
    assert.equal(cjsStereo.triangulateBearingPair(camWest, 90, camEast, 267), null); // 177° > 174°

    // 6. Range exceeding maxRangeM (default 4000m).
    const farTarget = sphericalDestination(KPCT.lat, KPCT.lon, 0, 5500);
    const bFar1 = cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, farTarget.lat, farTarget.lon);
    const bFar2 = cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, farTarget.lat, farTarget.lon);
    assert.equal(cjsStereo.triangulateBearingPair(camWest, bFar1, camEast, bFar2), null);
  });

  test('rejects stale camera frames (> maxSkewMs = 2500ms) and non-live / warmup / shaking cameras', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 0, 340);
    const boxWest = bboxForBearing(
      cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon),
      camWest
    );
    const boxEast = bboxForBearing(
      cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon),
      camEast
    );

    const baseA = {
      airport: 'KPCT',
      cameraId: 'cam-a',
      source: 'live',
      camera: camWest,
      updatedAt: 20_000,
      state: { learning: false, shake: false, tracks: [{ id: 1, bbox: boxWest, classification: 'drone' }] },
    };
    const baseB = {
      airport: 'KPCT',
      cameraId: 'cam-b',
      source: 'live',
      camera: camEast,
      updatedAt: 22_501, // 2501 ms skew > 2500 ms default maxSkewMs
      state: { learning: false, shake: false, tracks: [{ id: 2, bbox: boxEast, classification: 'drone' }] },
    };

    assert.equal(cjsStereo.correlateAirportCameras([baseA, baseB]).fixes.length, 0);
    assert.equal(
      cjsStereo.correlateAirportCameras([baseA, { ...baseB, updatedAt: 22_500 }]).fixes.length,
      1
    );

    // Non-live / warmup / shaking rejections
    for (const invalidOverride of [
      { source: 'upload' },
      { source: 'demo' },
      { demo: true },
      { online: false },
      { mode: 'unavailable' },
      { state: { learning: true, shake: false, tracks: baseB.state.tracks } },
      { state: { learning: false, shake: true, tracks: baseB.state.tracks } },
      { state: { learning: false, shake: false, overflow: true, tracks: baseB.state.tracks } },
    ]) {
      const res = cjsStereo.correlateAirportCameras([
        baseA,
        { ...baseB, updatedAt: 20_100, ...invalidOverride },
      ]);
      assert.equal(res.fixes.length, 0, `Expected 0 fixes for override ${JSON.stringify(invalidOverride)}`);
    }
  });

  test('never pairs incompatible bird vs drone tracks, while greedy-matching compatible tracks', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const truth1 = sphericalDestination(KPCT.lat, KPCT.lon, -8, 320);
    const truth2 = sphericalDestination(KPCT.lat, KPCT.lon, 14, 360);

    const boxW1 = bboxForBearing(cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth1.lat, truth1.lon), camWest);
    const boxE1 = bboxForBearing(cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth1.lat, truth1.lon), camEast);
    const boxW2 = bboxForBearing(cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth2.lat, truth2.lon), camWest);
    const boxE2 = bboxForBearing(cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth2.lat, truth2.lon), camEast);

    // Bird on Cam West + Drone on Cam East at the exact same location -> MUST NOT pair!
    const mismatch = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'cam-w',
        source: 'live',
        camera: camWest,
        updatedAt: 1000,
        state: { tracks: [{ id: 1, bbox: boxW1, classification: 'bird' }] },
      },
      {
        airport: 'KPCT',
        cameraId: 'cam-e',
        source: 'live',
        camera: camEast,
        updatedAt: 1020,
        state: { tracks: [{ id: 1, bbox: boxE1, classification: 'drone' }] },
      },
    ]);
    assert.deepEqual(mismatch.fixes, []);

    // Simultaneous 1 drone + 1 bird in scene -> correlates drone-with-drone and bird-with-bird cleanly.
    const multi = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'cam-w',
        source: 'live',
        camera: camWest,
        updatedAt: 1000,
        state: {
          tracks: [
            { id: 'd-w', bbox: boxW1, classification: 'drone' },
            { id: 'b-w', bbox: boxW2, classification: 'bird' },
          ],
        },
      },
      {
        airport: 'KPCT',
        cameraId: 'cam-e',
        source: 'live',
        camera: camEast,
        updatedAt: 1020,
        state: {
          tracks: [
            { id: 'b-e', bbox: boxE2, classification: 'bird' },
            { id: 'd-e', bbox: boxE1, classification: 'drone' },
          ],
        },
      },
    ]);
    assert.equal(multi.fixes.length, 2);
    const droneFix = multi.fixes.find(f => f.classification === 'drone');
    const birdFix = multi.fixes.find(f => f.classification === 'bird');
    assert.ok(droneFix && birdFix);
    assert.ok(haversineMeters(truth1.lat, truth1.lon, droneFix.lat, droneFix.lon) < 2.0);
    assert.ok(haversineMeters(truth2.lat, truth2.lon, birdFix.lat, birdFix.lon) < 2.0);
  });

  test('NEVER correlates cameras across different airports (KAAA vs KBBB)', () => {
    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 0, 330);
    const boxWest = bboxForBearing(
      cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon),
      camWest
    );
    const boxEast = bboxForBearing(
      cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon),
      camEast
    );

    const camKAAA = {
      airport: 'KAAA',
      cameraId: 'cam-kaaa',
      source: 'live',
      camera: camWest,
      updatedAt: 5000,
      state: { tracks: [{ id: 1, bbox: boxWest, classification: 'drone' }] },
    };
    const camKBBB = {
      airport: 'KBBB',
      cameraId: 'cam-kbbb',
      source: 'live',
      camera: camEast,
      updatedAt: 5000,
      state: { tracks: [{ id: 1, bbox: boxEast, classification: 'drone' }] },
    };

    // Stateless correlateAirportCameras with mixed airports
    assert.deepEqual(cjsStereo.correlateAirportCameras([camKAAA, camKBBB]).fixes, []);
    assert.deepEqual(cjsStereo.correlateAirportCameras([camKAAA, camKBBB], { airport: 'KAAA' }).fixes, []);
    assert.deepEqual(cjsStereo.correlateAirportCameras([camKAAA, camKBBB], { airport: 'KBBB' }).fixes, []);

    // Stateful createStereoRegistry
    let now = 5000;
    const registry = cjsStereo.createStereoRegistry({ now: () => now });
    const outA = registry.updateCamera(camKAAA);
    const outB = registry.updateCamera(camKBBB);
    assert.equal(outA.airport, 'KAAA');
    assert.equal(outA.cameraCount, 1);
    assert.deepEqual(outA.fixes, []);
    assert.equal(outB.airport, 'KBBB');
    assert.equal(outB.cameraCount, 1);
    assert.deepEqual(outB.fixes, []);
  });
});

describe('CJS <-> ESM parity, vm.runInNewContext safety, and createStereoRegistry lifecycle', () => {
  test('ESM stereo-triangulation.mjs and CJS stereo-triangulation.js produce identical outputs and CJS runs inside vm.runInNewContext', async () => {
    const esmPath = pathToFileURL(path.join(__dirname, '../public/js/stereo-triangulation.mjs')).href;
    const esmStereo = await import(esmPath);

    for (const fnName of [
      'triangulateBearingPair',
      'correlateAirportCameras',
      'bearingFromTrackBbox',
      'createStereoCorrelator',
      'createStereoRegistry',
    ]) {
      assert.equal(typeof esmStereo[fnName], 'function', `Missing ESM export ${fnName}`);
      assert.equal(typeof cjsStereo[fnName], 'function', `Missing CJS export ${fnName}`);
    }

    const { camWest, camEast } = princetonCameraPair(250);
    const cjsFix = cjsStereo.triangulateBearingPair(camWest, 18.5, camEast, 341.2);
    const esmFix = esmStereo.triangulateBearingPair(camWest, 18.5, camEast, 341.2);
    assert.deepEqual(esmFix, cjsFix);

    // Verify pure synchronous CJS loading inside vm.runInNewContext (as used by site-flow.test.cjs).
    const cjsCode = fs.readFileSync(path.join(__dirname, '../stereo-triangulation.js'), 'utf8');
    const strippedCjs = cjsCode.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(strippedCjs, /\bimport\s*\(/, 'CJS module must not contain dynamic import()');
    assert.doesNotMatch(cjsCode, /\bimport\s*\(/, 'CJS module must not mention import()');
    const sandbox = { module: { exports: {} }, exports: {} };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(cjsCode, sandbox);
    const vmFix = sandbox.module.exports.triangulateBearingPair(camWest, 18.5, camEast, 341.2);
    assert.equal(vmFix.lat, cjsFix.lat);
    assert.equal(vmFix.lon, cjsFix.lon);
    assert.equal(vmFix.uncertaintyRadiusM, cjsFix.uncertaintyRadiusM);
  });

  test('createStereoRegistry tracks live camera config/state, expires stale state, and handles removeCamera & clearAirport', () => {
    let clockMs = 100_000;
    const registry = cjsStereo.createStereoRegistry({ maxSkewMs: 2500, now: () => clockMs });
    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 5, 300);
    const boxW = bboxForBearing(cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon), camWest);
    const boxE = bboxForBearing(cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon), camEast);

    // Configure both cameras first (as camera:config does before frames arrive).
    assert.equal(
      registry.configureCamera({
        airport: 'KPCT',
        cameraId: 'cam-1',
        cameraLabel: 'West Tower',
        streamId: 's1',
        source: 'live',
        config: { camera: camWest },
      }),
      true
    );
    assert.equal(
      registry.configureCamera({
        airport: 'KPCT',
        cameraId: 'cam-2',
        cameraLabel: 'East Tower',
        streamId: 's2',
        source: 'live',
        config: { camera: camEast },
      }),
      true
    );
    assert.equal(registry.correlate('KPCT').fixes.length, 0);

    // Deliver states well after initial config (verifying pose persists across frames).
    clockMs += 30_000;
    registry.updateCamera({
      airport: 'KPCT',
      cameraId: 'cam-1',
      streamId: 's1',
      state: { learning: false, shake: false, tracks: [{ id: 1, bbox: boxW, classification: 'drone' }] },
    });
    clockMs += 80;
    const active = registry.updateCamera({
      airport: 'KPCT',
      cameraId: 'cam-2',
      streamId: 's2',
      state: { learning: false, shake: false, tracks: [{ id: 4, bbox: boxE, classification: 'drone' }] },
    });
    assert.equal(active.cameraCount, 2);
    assert.equal(active.fixes.length, 1);

    // Advance past maxSkewMs -> stale camera frames pruned automatically.
    clockMs += 2600;
    const expired = registry.correlate('KPCT');
    assert.equal(expired.cameraCount, 0);
    assert.equal(expired.fixes.length, 0);

    // Refresh both, then test removeCamera and clearAirport.
    registry.updateCamera({
      airport: 'KPCT',
      cameraId: 'cam-1',
      state: { tracks: [{ id: 1, bbox: boxW, classification: 'drone' }] },
    });
    registry.updateCamera({
      airport: 'KPCT',
      cameraId: 'cam-2',
      state: { tracks: [{ id: 4, bbox: boxE, classification: 'drone' }] },
    });
    assert.equal(registry.correlate('KPCT').fixes.length, 1);

    assert.equal(registry.removeCamera('cam-1'), true);
    assert.equal(registry.correlate('KPCT').cameraCount, 1);
    assert.equal(registry.correlate('KPCT').fixes.length, 0);

    assert.equal(registry.clearAirport('KPCT'), 1);
    assert.equal(registry.size, 0);
  });
});

describe('createTowerStereoLayer Leaflet overlay & safety guards', () => {
  function createFullMockLeaflet() {
    const created = [];
    const groups = [];

    function makeLayer(kind, coords, options) {
      const el = { dataset: {}, setAttribute(k, v) { this.dataset[k] = v; } };
      const layer = {
        kind,
        coords,
        options: { ...options },
        popup: null,
        tooltip: null,
        updates: 0,
        styleUpdates: 0,
        removed: false,
        addedTarget: null,
        getElement: () => el,
        bindPopup(content, popupOpts) {
          this.popup = { content, options: popupOpts };
          return this;
        },
        bindTooltip(content, tooltipOpts) {
          this.tooltip = { content, options: tooltipOpts };
          return this;
        },
        setTooltipContent(content) {
          if (this.tooltip) this.tooltip.content = content;
          return this;
        },
        addTo(target) {
          this.addedTarget = target;
          target?.addLayer?.(this);
          return this;
        },
        setLatLng(next) {
          this.coords = next;
          this.updates++;
          return this;
        },
        setLatLngs(next) {
          this.coords = next;
          this.updates++;
          return this;
        },
        setStyle(patch) {
          Object.assign(this.options, patch);
          this.styleUpdates++;
          return this;
        },
        remove() {
          this.removed = true;
        },
      };
      created.push(layer);
      return layer;
    }

    const L = {
      layerGroup() {
        const members = new Set();
        const group = {
          members,
          removed: false,
          cleared: false,
          addLayer(l) { members.add(l); },
          removeLayer(l) { members.delete(l); },
          clearLayers() { members.clear(); this.cleared = true; },
          addTo(map) { this.map = map; return this; },
          remove() { this.removed = true; },
        };
        groups.push(group);
        return group;
      },
      polyline: (latlngs, opts) => makeLayer('polyline', latlngs, opts),
      polygon: (latlngs, opts) => makeLayer('polygon', latlngs, opts),
      circleMarker: (latlng, opts) => makeLayer('circleMarker', latlng, opts),
    };

    const map = { setView() { return this; } };
    return { L, map, created, groups };
  }

  test('returns safe no-op controller for partial tower-safety.test.cjs mock L without throwing', async () => {
    const { createTowerStereoLayer } = await import('../public/js/tower-stereo-layer.mjs');
    const partialL = {
      map: () => ({ setView() { return this; } }),
      tileLayer: () => ({ addTo() {} }),
    };
    const map = partialL.map();
    const controller = createTowerStereoLayer(partialL, map);

    assert.equal(controller.updateStereo({ cameraCount: 2, fixes: [] }), 0);
    assert.deepEqual(controller.getFixes(), []);
    assert.doesNotThrow(() => {
      controller.prune();
      controller.clear();
      controller.destroy();
    });
  });

  test('renders rays, uncertainty polygon, and accessible fix marker, reuses layers on update, and rejects single-camera inputs', async () => {
    const { createTowerStereoLayer } = await import('../public/js/tower-stereo-layer.mjs');
    const { L, map, created, groups } = createFullMockLeaflet();

    let nowMs = 50_000;
    const stereoLayer = createTowerStereoLayer(L, map, {
      now: () => nowMs,
      staleMs: 3000,
      airport: 'KPCT',
    });

    const { camWest, camEast } = princetonCameraPair(250);
    const truth = sphericalDestination(KPCT.lat, KPCT.lon, 6, 330);
    const boxW = bboxForBearing(cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, truth.lat, truth.lon), camWest);
    const boxE = bboxForBearing(cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, truth.lat, truth.lon), camEast);

    const payload = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'cam-w',
        cameraLabel: 'West Gate',
        source: 'live',
        camera: camWest,
        updatedAt: nowMs,
        state: { tracks: [{ id: 1, bbox: boxW, classification: 'drone' }] },
      },
      {
        airport: 'KPCT',
        cameraId: 'cam-e',
        cameraLabel: 'East Gate',
        source: 'live',
        camera: camEast,
        updatedAt: nowMs,
        state: { tracks: [{ id: 2, bbox: boxE, classification: 'drone' }] },
      },
    ], { now: nowMs });

    assert.equal(stereoLayer.updateStereo(payload), 1);
    assert.equal(groups.length, 1);

    const rays = created.filter(l => l.options.className === 'stereo-ray-line');
    const polys = created.filter(l => l.options.className === 'stereo-uncertainty-poly');
    const markers = created.filter(l => l.options.className === 'stereo-fix-marker');
    assert.equal(rays.length, 2);
    assert.equal(polys.length, 1);
    assert.equal(markers.length, 1);

    const popupText = markers[0].popup.content.textContent;
    assert.match(popupText, /DRONE/);
    assert.match(popupText, /West Gate/);
    assert.match(popupText, /East Gate/);
    assert.match(popupText, /Baseline:\s*\d+m/);
    assert.match(popupText, /±\d+m/);
    assert.match(popupText, /Advisory 2-camera bearing intersection — not radar or clearance/);

    // Updating the same fix in place reuses Leaflet layers instead of recreating them.
    const countBeforeUpdate = created.length;
    nowMs += 200;
    const movedTruth = sphericalDestination(KPCT.lat, KPCT.lon, 9, 345);
    const nextPayload = cjsStereo.correlateAirportCameras([
      {
        airport: 'KPCT',
        cameraId: 'cam-w',
        cameraLabel: 'West Gate',
        source: 'live',
        camera: camWest,
        updatedAt: nowMs,
        state: {
          tracks: [{
            id: 1,
            bbox: bboxForBearing(cjsStereo.bearingBetweenPoints(camWest.lat, camWest.lon, movedTruth.lat, movedTruth.lon), camWest),
            classification: 'drone',
          }],
        },
      },
      {
        airport: 'KPCT',
        cameraId: 'cam-e',
        cameraLabel: 'East Gate',
        source: 'live',
        camera: camEast,
        updatedAt: nowMs,
        state: {
          tracks: [{
            id: 2,
            bbox: bboxForBearing(cjsStereo.bearingBetweenPoints(camEast.lat, camEast.lon, movedTruth.lat, movedTruth.lon), camEast),
            classification: 'drone',
          }],
        },
      },
    ], { now: nowMs });

    assert.equal(stereoLayer.updateStereo(nextPayload), 1);
    assert.equal(created.length, countBeforeUpdate, 'Expected existing Leaflet layers to be updated in place');
    assert.equal(markers[0].updates, 1);
    assert.equal(polys[0].updates, 1);

    // Single-camera or forged 1-camera fix input renders ZERO target points on the map.
    const forgedOneCamFix = {
      ...nextPayload.fixes[0],
      cameras: [nextPayload.fixes[0].cameras[0]],
    };
    assert.equal(stereoLayer.updateStereo({ airport: 'KPCT', cameraCount: 2, fixes: [forgedOneCamFix] }), 0);
    assert.equal(stereoLayer.getFixes().length, 0);
    assert.equal(markers[0].removed, true);

    // Re-add, expire via prune(), then clear() and destroy().
    assert.equal(stereoLayer.updateStereo(nextPayload), 1);
    assert.equal(stereoLayer.getFixes().length, 1);

    nowMs += 3500; // > staleMs (3000ms)
    stereoLayer.prune();
    assert.equal(stereoLayer.getFixes().length, 0);

    nowMs = 60_000;
    const freshAgain = {
      ...nextPayload,
      updatedAt: nowMs,
      fixes: [{ ...nextPayload.fixes[0], updatedAt: nowMs }],
    };
    assert.equal(stereoLayer.updateStereo(freshAgain), 1);
    stereoLayer.clear();
    assert.equal(stereoLayer.getFixes().length, 0);

    stereoLayer.destroy();
    assert.equal(groups[0].removed, true);
    assert.equal(stereoLayer.updateStereo(freshAgain), 0);
  });
});
