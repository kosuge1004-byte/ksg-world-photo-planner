// 2026-10-15: ARカメラの「カメラ焦点距離補正」。35mm判換算の焦点距離から、画面に見えている画角を求める。
import assert from "node:assert/strict";
import test from "node:test";

import {
  AR_DEFAULT_FOCAL_LENGTH_MM,
  EQUIVALENT_LONG_SIDE_MM,
  displayedFieldOfViewDegrees,
  equivalentFocalLengthFromSensor,
  loadArFocalLength,
  roundFocalLengthMm,
  saveArFocalLength,
} from "../../src/ar/cameraFocalLength.ts";

const DEG = Math.PI / 180;
const halfTan = (degrees) => Math.tan(degrees * DEG / 2);

test("portrait 9:16 video on a taller screen: the full sensor long side is the vertical view", () => {
  const fov = displayedFieldOfViewDegrees({
    focalLengthMm: 26, videoWidth: 1080, videoHeight: 1920, viewWidth: 412, viewHeight: 915,
  });
  // 縦：センサー長辺いっぱい（34.61mm相当 / 26mm）
  assert.ok(Math.abs(halfTan(fov.verticalFovDeg) - EQUIVALENT_LONG_SIDE_MM / 52) < 1e-12);
  // 横：画面の縦横比どおり（object-fit: coverで左右が切れる）
  assert.ok(Math.abs(halfTan(fov.horizontalFovDeg) / halfTan(fov.verticalFovDeg) - 412 / 915) < 1e-12);
  assert.ok(Math.abs(fov.verticalFovDeg - 67.30) < 0.01, String(fov.verticalFovDeg));
});

test("wider screen than the video: the horizontal side is filled and the vertical side is cropped", () => {
  const fov = displayedFieldOfViewDegrees({
    focalLengthMm: 24, videoWidth: 1080, videoHeight: 1920, viewWidth: 600, viewHeight: 800,
  });
  const fullShortHalfTan = (EQUIVALENT_LONG_SIDE_MM / 48) * 1080 / 1920;
  assert.ok(Math.abs(halfTan(fov.horizontalFovDeg) - fullShortHalfTan) < 1e-12);
  assert.ok(Math.abs(halfTan(fov.horizontalFovDeg) / halfTan(fov.verticalFovDeg) - 600 / 800) < 1e-12);
});

test("the ratio of horizontal and vertical view always equals the screen ratio (what Cesium assumes)", () => {
  for (const [vw, vh, sw, sh] of [[1920, 1080, 915, 412], [1080, 1920, 412, 915], [1440, 1080, 390, 844], [null, null, 400, 700]]) {
    const fov = displayedFieldOfViewDegrees({ focalLengthMm: 25, videoWidth: vw, videoHeight: vh, viewWidth: sw, viewHeight: sh });
    assert.ok(Math.abs(halfTan(fov.horizontalFovDeg) / halfTan(fov.verticalFovDeg) - sw / sh) < 1e-12);
  }
});

test("longer focal length narrows the view in proportion", () => {
  const a = displayedFieldOfViewDegrees({ focalLengthMm: 25, videoWidth: 1080, videoHeight: 1920, viewWidth: 412, viewHeight: 915 });
  const b = displayedFieldOfViewDegrees({ focalLengthMm: 50, videoWidth: 1080, videoHeight: 1920, viewWidth: 412, viewHeight: 915 });
  assert.ok(Math.abs(halfTan(a.verticalFovDeg) / halfTan(b.verticalFovDeg) - 2) < 1e-12);
});

test("Android lens info: the sensor long side is used whichever way the size is reported", () => {
  const landscape = equivalentFocalLengthFromSensor({ focalLengthMm: 6.9, sensorWidthMm: 9.8, sensorHeightMm: 7.4 });
  const portrait = equivalentFocalLengthFromSensor({ focalLengthMm: 6.9, sensorWidthMm: 7.4, sensorHeightMm: 9.8 });
  assert.equal(landscape, portrait);
  assert.ok(Math.abs(landscape - 6.9 * EQUIVALENT_LONG_SIDE_MM / 9.8) < 1e-12);
  assert.equal(equivalentFocalLengthFromSensor({ focalLengthMm: 6.9, sensorWidthMm: null, sensorHeightMm: 7.4 }), null);
});

test("0.1 mm steps and the allowed range", () => {
  assert.equal(roundFocalLengthMm(25.04), 25);
  assert.equal(roundFocalLengthMm(25 + 0.1), 25.1);
  assert.equal(roundFocalLengthMm(25.1 - 0.1), 25);
  assert.equal(roundFocalLengthMm(1), 10);
  assert.equal(roundFocalLengthMm(500), 100);
  assert.equal(AR_DEFAULT_FOCAL_LENGTH_MM, 25);
});

test("the corrected value is kept per camera and ignored for a different camera", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  assert.equal(loadArFocalLength("camera2 0, facing back"), null);
  assert.equal(saveArFocalLength(24.3, "camera2 0, facing back"), true);
  assert.equal(loadArFocalLength("camera2 0, facing back"), 24.3);
  assert.equal(loadArFocalLength("camera2 2, facing back"), null);
  delete globalThis.localStorage;
});
