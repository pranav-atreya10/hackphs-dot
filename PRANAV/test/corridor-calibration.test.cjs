const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readSurveys, surveyedCorridor, sanitizeMetrics } = require("../corridor-calibration");

const camera = { lat: 1, lon: 2, heading_deg: 90, hfov_deg: 65, pitch_deg: 20 };
const record = { airport: "TEST", cameraId: "test-camera", camera, surveyId: "test-survey",
  polygon: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] };

test("a configured survey is scoped to the installed webcam and exact pose", () => {
  const surveys = readSurveys(JSON.stringify([record]));
  assert.equal(surveyedCorridor(surveys, record, camera, "webcam").surveyId, record.surveyId);
  assert.equal(surveyedCorridor(surveys, record, camera, "clip"), null);
  assert.equal(surveyedCorridor(surveys, record, { ...camera, heading_deg: 91 }, "webcam"), null);
  assert.equal(surveyedCorridor(surveys, { ...record, airport: "OTHER" }, camera, "webcam"), null);
  assert.throws(() => readSurveys(JSON.stringify([record, record])), /Duplicate/);
});

test("event ingress never stores guessed geography and only retains approved image ETA", () => {
  const event = { bearing_deg: 90, target_geo: {}, path_geo: {}, eta_seconds: 0,
    eta_basis: "image_space_corridor", corridor_survey_id: "test-survey", direction: "heading N, inside the image-space corridor mask" };
  assert.deepEqual(sanitizeMetrics(event, null), {
    bearing_deg: 90, eta_seconds: null, eta_range: null, eta_basis: null, corridor_survey_id: null, direction: "heading N",
  });
  assert.equal(sanitizeMetrics(event, record.surveyId).eta_seconds, 0);
  assert.equal(sanitizeMetrics({ ...event, eta_basis: "synthetic_image_space_corridor" }, record.surveyId).eta_seconds, null);
});
