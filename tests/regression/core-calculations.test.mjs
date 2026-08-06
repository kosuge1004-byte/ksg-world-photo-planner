import assert from "node:assert/strict";
import test from "node:test";

import {
  sensorDimensionsMm,
} from "../../src/cesium/camera.ts";
import {
  calculateCelestialHorizontalCoordinates,
  calculateCelestialScreenPoints,
  celestialAngularDiameterDegrees,
  createCameraProjection,
  isCelestialInCameraFrame,
  projectHorizontalToPreview,
} from "../../src/cesium/celestial.ts";
import { calculateKarneyDestinationPoint } from "../../src/geodesy/karneyGeodesic.ts";
import {
  prepareRefractionWeatherContext,
  weatherRefractionCorrectionDegrees,
} from "../../src/search/refractionWeather.ts";
import { searchCelestialTransitDates } from "../../src/search/celestialTransitSearch.ts";
import { isCelestialOcclusionConfirmedHidden } from "../../src/types/celestial.ts";
import {
  classifyTerrainOcclusion,
  TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES,
} from "../../src/celestial/terrainOcclusionPolicy.ts";

globalThis.window ??= { setTimeout: globalThis.setTimeout };

const FIXED_DATE = new Date("2026-03-20T03:00:00.000Z");
const TOKYO = {
  latitude: 35.681236,
  longitude: 139.767125,
  height: 10,
  label: "Tokyo",
};
const CAMERA = {
  focalLengthMm: 35,
  lensCenterHeightMeters: 1.6,
};

const TOLERANCE = {
  dimensionsMillimeters: 1e-10,
  fieldOfViewDegrees: 1e-9,
  angularDiameterDegrees: 1e-8,
  screenPercent: 1e-7,
  correctionDegrees: 1e-10,
};

function closeTo(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function signedDegrees(value) {
  return ((value + 540) % 360) - 180;
}

function azimuthFromForward(forward) {
  return normalizeDegrees(Math.atan2(forward.east, forward.north) * 180 / Math.PI);
}

function altitudeFromForward(forward) {
  return Math.asin(forward.up) * 180 / Math.PI;
}

test("terrain horizon uncertainty does not turn a visible body into confirmed obstruction", () => {
  const celestialAltitudeDegrees = 10.01;
  const terrainElevationDegrees = 10;
  const formerRuleObstructed =
    terrainElevationDegrees >= celestialAltitudeDegrees - 0.015;
  assert.equal(formerRuleObstructed, true, "the former one-sided rule must reproduce the false positive");

  assert.deepEqual(
    classifyTerrainOcclusion(celestialAltitudeDegrees, terrainElevationDegrees),
    { clearanceDegrees: 0.009999999999999787, status: "uncertain" },
  );
  assert.equal(
    classifyTerrainOcclusion(10.02, 10).status,
    "visible",
    "clear terrain must remain visible",
  );
  assert.equal(
    classifyTerrainOcclusion(9.98, 10).status,
    "obstructed",
    "terrain clearly above the body must remain obstructed",
  );
  assert.equal(TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES, 0.015);
});

test("full-frame sensor dimensions and horizontal/vertical field of view", () => {
  const landscape = sensorDimensionsMm(1.5);
  const square = sensorDimensionsMm(1);
  const wide = sensorDimensionsMm(2);
  closeTo(landscape.width, 36, TOLERANCE.dimensionsMillimeters, "3:2 sensor width");
  closeTo(landscape.height, 24, TOLERANCE.dimensionsMillimeters, "3:2 sensor height");
  closeTo(square.width, 24, TOLERANCE.dimensionsMillimeters, "1:1 sensor width");
  closeTo(square.height, 24, TOLERANCE.dimensionsMillimeters, "1:1 sensor height");
  closeTo(wide.width, 36, TOLERANCE.dimensionsMillimeters, "2:1 sensor width");
  closeTo(wide.height, 18, TOLERANCE.dimensionsMillimeters, "2:1 sensor height");

  const subject = calculateKarneyDestinationPoint(TOKYO, 180, 1000);
  const projection = createCameraProjection(TOKYO, subject, CAMERA, 1.5);
  closeTo(
    projection.horizontalFov,
    54.43222311461495,
    TOLERANCE.fieldOfViewDegrees,
    "35mm horizontal field of view",
  );
  closeTo(
    projection.verticalFov,
    37.84928883210247,
    TOLERANCE.fieldOfViewDegrees,
    "35mm vertical field of view",
  );
});

test("viewCorrection changes the shared camera projection exactly once", () => {
  const subject = calculateKarneyDestinationPoint(TOKYO, 180, 1000);
  const base = createCameraProjection(TOKYO, subject, CAMERA, 1.5, "standard");
  const corrected = createCameraProjection(
    TOKYO,
    subject,
    CAMERA,
    1.5,
    "standard",
    { azimuthDegrees: 7.5, altitudeDegrees: -2.25 },
  );
  closeTo(
    signedDegrees(azimuthFromForward(corrected.forward) - azimuthFromForward(base.forward)),
    7.5,
    TOLERANCE.correctionDegrees,
    "viewCorrection azimuth",
  );
  closeTo(
    altitudeFromForward(corrected.forward) - altitudeFromForward(base.forward),
    -2.25,
    TOLERANCE.correctionDegrees,
    "viewCorrection altitude",
  );
});

test("Sun and Moon angular diameters stay at the fixed astronomical reference", () => {
  closeTo(
    celestialAngularDiameterDegrees("sun", FIXED_DATE, TOKYO),
    0.5351792761197687,
    TOLERANCE.angularDiameterDegrees,
    "Sun angular diameter",
  );
  closeTo(
    celestialAngularDiameterDegrees("moon", FIXED_DATE, TOKYO),
    0.5464836128806364,
    TOLERANCE.angularDiameterDegrees,
    "Moon angular diameter",
  );
});

test("Sun and Moon screen coordinates use the shared pinhole projection", () => {
  const subject = calculateKarneyDestinationPoint(TOKYO, 180, 1000);
  const points = calculateCelestialScreenPoints(
    FIXED_DATE,
    TOKYO,
    subject,
    CAMERA,
    1.5,
    "standard",
    { azimuthDegrees: 0, altitudeDegrees: 30 },
  );
  const sun = points.find((point) => point.id === "sun");
  const moon = points.find((point) => point.id === "moon");
  assert.ok(sun, "Sun screen point is missing");
  assert.ok(moon, "Moon screen point is missing");
  // 被写体方向の仰角に地表屈折補正（k=0.13、距離1000m）を追加したことに伴う参照値。
  closeTo(sun.xPercent, 55.36369299290154, TOLERANCE.screenPercent, "Sun x");
  closeTo(sun.yPercent, -15.600027488591977, TOLERANCE.screenPercent, "Sun y");
  closeTo(moon.xPercent, 32.07467942050593, TOLERANCE.screenPercent, "Moon x");
  closeTo(moon.yPercent, -41.55463328908209, TOLERANCE.screenPercent, "Moon y");
});

test("frame rule includes the center and excludes a point outside the pinhole frame", () => {
  const projection = {
    horizontalFov: 60,
    verticalFov: 40,
    forward: { east: 0, north: 1, up: 0 },
    right: { east: 1, north: 0, up: 0 },
    up: { east: 0, north: 0, up: 1 },
  };
  const center = projectHorizontalToPreview(
    { azimuthDegrees: 0, altitudeDegrees: 0 },
    projection,
  );
  closeTo(center.xPercent, 50, TOLERANCE.screenPercent, "frame center x");
  closeTo(center.yPercent, 50, TOLERANCE.screenPercent, "frame center y");
  assert.equal(center.visibleInFrame, true);
  assert.equal(
    isCelestialInCameraFrame(
      "milkyWay",
      FIXED_DATE,
      TOKYO,
      { azimuthDegrees: 0, altitudeDegrees: 0 },
      projection,
      "standard",
    ),
    true,
  );
  assert.equal(
    isCelestialInCameraFrame(
      "milkyWay",
      FIXED_DATE,
      TOKYO,
      { azimuthDegrees: 31, altitudeDegrees: 0 },
      projection,
      "standard",
    ),
    false,
  );
});

test("weather refraction has a numeric reference and automatic mode falls back", async () => {
  closeTo(
    weatherRefractionCorrectionDegrees(0, {
      temperatureCelsius: 10,
      relativeHumidityPercent: 50,
      surfacePressureHpa: 1010,
    }),
    0.48192392443137894,
    TOLERANCE.angularDiameterDegrees,
    "Bennett refraction at horizon",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("intentional regression-test network failure");
  };
  try {
    const context = await prepareRefractionWeatherContext({
      mode: "auto",
      point: TOKYO,
      searchStart: new Date("2026-03-20T00:00:00.000Z"),
      searchEnd: new Date("2026-03-21T00:00:00.000Z"),
      now: new Date("2026-03-20T00:00:00.000Z"),
      signal: new AbortController().signal,
    });
    assert.equal(context.effectiveMode, "standard");
    assert.equal(context.source, "fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direction-crossing search returns only a result inside the same camera frame", async () => {
  const subject = calculateKarneyDestinationPoint(TOKYO, 100, 1000);
  const input = {
    currentDate: new Date("2026-03-20T00:00:00.000Z"),
    timeZone: "Asia/Tokyo",
    tripod: TOKYO,
    subject,
    visibility: { sun: true, moon: false, milkyWay: false, polaris: false },
    calculationMode: "standard",
    cameraSettings: { focalLengthMm: 9, lensCenterHeightMeters: 1.6 },
    previewAspectRatio: 1.5,
    criteria: {
      mode: "direction-crossing",
      period: "custom",
      customStartDate: "2026-03-20",
      customEndDate: "2026-03-20",
      weekdays: [],
      startTime: "00:00",
      endTime: "23:59",
      displayCount: 10,
      includeBelowSubject: true,
      viewCorrection: { azimuthDegrees: 0, altitudeDegrees: 0 },
    },
  };
  const results = await searchCelestialTransitDates(
    input,
    new AbortController().signal,
    () => {},
  );
  assert.equal(results.length, 1, `expected one Sun crossing, received ${results.length}`);
  assert.equal(results[0].celestialId, "sun");

  const observer = {
    ...TOKYO,
    height: TOKYO.height + input.cameraSettings.lensCenterHeightMeters,
  };
  const horizontal = calculateCelestialHorizontalCoordinates(
    "sun",
    results[0].date,
    observer,
    "standard",
  );
  const projection = createCameraProjection(
    TOKYO,
    subject,
    input.cameraSettings,
    input.previewAspectRatio,
    input.criteria.viewCorrection,
  );
  assert.equal(
    isCelestialInCameraFrame(
      "sun",
      results[0].date,
      observer,
      horizontal,
      projection,
      input.calculationMode,
    ),
    true,
    "crossing result is outside the preview frame",
  );
});

test("occlusion states never confirm pending/failed and do confirm below-horizon", () => {
  const base = {
    visible: false,
    reason: "unverified",
    terrainObstructed: false,
    photorealisticMeshObstructed: false,
  };
  assert.equal(
    isCelestialOcclusionConfirmedHidden({
      ...base,
      verificationState: "checking",
      reason: "terrain",
      terrainObstructed: true,
    }),
    false,
  );
  assert.equal(
    isCelestialOcclusionConfirmedHidden({
      ...base,
      verificationState: "failed",
      reason: "building-or-surface",
      photorealisticMeshObstructed: true,
    }),
    false,
  );
  assert.equal(
    isCelestialOcclusionConfirmedHidden({
      ...base,
      verificationState: "dem-only",
      reason: "terrain",
      terrainObstructed: true,
    }),
    true,
  );
  assert.equal(
    isCelestialOcclusionConfirmedHidden({
      ...base,
      verificationState: "dem-and-google-3d",
      reason: "below-horizon",
    }),
    true,
  );
});
