import { Geodesic } from "geographiclib-geodesic";

const EARTH_RADIUS_METERS = 6371008.8;
const DISTANCE_TOLERANCE_METERS = 1e-6;
const BEARING_TOLERANCE_DEGREES = 1e-10;

const cases = [
  {
    name: "short_local",
    from: [35.183, 136.857],
    to: [35.184, 136.859],
    expectedDistanceMeters: 213.2924484060868,
    expectedInitialBearingDegrees: 58.65715047893593,
  },
  {
    name: "nagoya_tokyo",
    from: [35.1815, 136.9066],
    to: [35.6812, 139.7671],
    expectedDistanceMeters: 265591.87388393166,
    expectedInitialBearingDegrees: 77.12488365196589,
  },
  {
    name: "dateline",
    from: [35.0, 179.9],
    to: [35.0, -179.9],
    expectedDistanceMeters: 18257.63087971887,
    expectedInitialBearingDegrees: 89.94264231710821,
  },
  {
    name: "near_antipodal",
    from: [0.0, 0.0],
    to: [0.5, 179.5],
    expectedDistanceMeters: 19936288.578965314,
    expectedInitialBearingDegrees: 25.67187286829187,
  },
];

function normalizeBearingDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeSignedAngleDegrees(value) {
  return ((value + 540) % 360) - 180;
}

function sphericalInverse(from, to) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const toDegrees = (value) => (value * 180) / Math.PI;
  const lat1 = toRadians(from[0]);
  const lat2 = toRadians(to[0]);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(to[1] - from[1]);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const distanceMeters =
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return {
    distanceMeters,
    bearingDegrees: normalizeBearingDegrees(toDegrees(Math.atan2(y, x))),
  };
}

let failed = false;

for (const testCase of cases) {
  const result = Geodesic.WGS84.Inverse(
    testCase.from[0],
    testCase.from[1],
    testCase.to[0],
    testCase.to[1],
    Geodesic.STANDARD
  );
  const karneyBearing = normalizeBearingDegrees(result.azi1);
  const distanceError = result.s12 - testCase.expectedDistanceMeters;
  const bearingError = normalizeSignedAngleDegrees(
    karneyBearing - testCase.expectedInitialBearingDegrees
  );
  const spherical = sphericalInverse(testCase.from, testCase.to);

  const passed =
    Math.abs(distanceError) <= DISTANCE_TOLERANCE_METERS &&
    Math.abs(bearingError) <= BEARING_TOLERANCE_DEGREES;
  failed ||= !passed;

  console.log(
    JSON.stringify({
      name: testCase.name,
      passed,
      karneyDistanceMeters: result.s12,
      karneyBearingDegrees: karneyBearing,
      referenceDistanceErrorMeters: distanceError,
      referenceBearingErrorDegrees: bearingError,
      sphericalMinusKarneyDistanceMeters:
        spherical.distanceMeters - result.s12,
      sphericalMinusKarneyBearingDegrees: normalizeSignedAngleDegrees(
        spherical.bearingDegrees - karneyBearing
      ),
    })
  );
}

if (failed) {
  process.exitCode = 1;
}
