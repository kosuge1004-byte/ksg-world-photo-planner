const EARTH_RADIUS_METERS = 6371008.8;

const cases = [
  { name: "short_local", from: [35.183, 136.857], to: [35.184, 136.859], expectedDistanceMeters: 213.2924484060868, expectedInitialBearingDegrees: 58.65715047893593 },
  { name: "nagoya_tokyo", from: [35.1815, 136.9066], to: [35.6812, 139.7671], expectedDistanceMeters: 265591.87388393166, expectedInitialBearingDegrees: 77.12488365196589 },
  { name: "dateline", from: [35.0, 179.9], to: [35.0, -179.9], expectedDistanceMeters: 18257.63087971887, expectedInitialBearingDegrees: 89.94264231710821 },
  { name: "near_antipodal", from: [0.0, 0.0], to: [0.5, 179.5], expectedDistanceMeters: 19936288.578965314, expectedInitialBearingDegrees: 25.67187286829187 },
];

function normalizeLongitudeDeltaDegrees(value) {
  return ((value + 540) % 360) - 180;
}

function currentSphericalInverse(from, to) {
  const toRadians = (value) => value * Math.PI / 180;
  const toDegrees = (value) => value * 180 / Math.PI;
  const lat1 = toRadians(from[0]);
  const lat2 = toRadians(to[0]);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(normalizeLongitudeDeltaDegrees(to[1] - from[1]));
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const distanceMeters = 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const initialBearingDegrees = (toDegrees(Math.atan2(y, x)) + 360) % 360;
  return { distanceMeters, initialBearingDegrees };
}

for (const testCase of cases) {
  const actual = currentSphericalInverse(testCase.from, testCase.to);
  console.log(JSON.stringify({
    name: testCase.name,
    sphericalDistanceErrorMeters: actual.distanceMeters - testCase.expectedDistanceMeters,
    sphericalBearingErrorDegrees: actual.initialBearingDegrees - testCase.expectedInitialBearingDegrees,
  }));
}
