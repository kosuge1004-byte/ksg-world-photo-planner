import geographicLibGeodesic from "geographiclib-geodesic";

const { Geodesic } = geographicLibGeodesic;

const COORDINATE_TOLERANCE_DEGREES = 1e-11;

const cases = [
  {
    name: "short_local",
    origin: [35.183, 136.857],
    bearingDegrees: 58.65715047893593,
    distanceMeters: 213.2924484060868,
    expected: [35.184, 136.859],
  },
  {
    name: "nagoya_tokyo",
    origin: [35.1815, 136.9066],
    bearingDegrees: 77.12488365196589,
    distanceMeters: 265591.87388393166,
    expected: [35.6812, 139.7671],
  },
  {
    name: "dateline",
    origin: [35.0, 179.9],
    bearingDegrees: 89.94264231710821,
    distanceMeters: 18257.63087971887,
    expected: [35.0, -179.9],
  },
  {
    name: "near_antipodal",
    origin: [0.0, 0.0],
    bearingDegrees: 25.67187286829187,
    distanceMeters: 19936288.578965314,
    expected: [0.5, 179.5],
  },
];

function normalizeSignedLongitudeDifference(value) {
  return ((value + 540) % 360) - 180;
}

let failed = false;

for (const testCase of cases) {
  const result = Geodesic.WGS84.Direct(
    testCase.origin[0],
    testCase.origin[1],
    testCase.bearingDegrees,
    testCase.distanceMeters,
    Geodesic.STANDARD
  );

  const latitudeError = result.lat2 - testCase.expected[0];
  const longitudeError = normalizeSignedLongitudeDifference(
    result.lon2 - testCase.expected[1]
  );
  const passed =
    Number.isFinite(result.lat2) &&
    Number.isFinite(result.lon2) &&
    Math.abs(latitudeError) <= COORDINATE_TOLERANCE_DEGREES &&
    Math.abs(longitudeError) <= COORDINATE_TOLERANCE_DEGREES;

  failed ||= !passed;
  console.log(
    JSON.stringify({
      name: testCase.name,
      passed,
      latitude: result.lat2,
      longitude: result.lon2,
      latitudeErrorDegrees: latitudeError,
      longitudeErrorDegrees: longitudeError,
    })
  );
}

if (failed) {
  process.exitCode = 1;
}
