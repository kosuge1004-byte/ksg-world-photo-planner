import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/geodesy/karneyGeodesic.ts", import.meta.url), "utf8");

assert.match(source, /COINCIDENT_DISTANCE_EPSILON_METERS\s*=\s*1e-6/);
assert.match(source, /ANTIPODAL_POSTCONDITION_DISTANCE_METERS\s*=\s*19_000_000/);
assert.match(source, /GEODESIC_POSTCONDITION_TOLERANCE_DEGREES\s*=\s*1e-8/);
assert.match(source, /distanceMeters\s*<\s*COINCIDENT_DISTANCE_EPSILON_METERS/);
assert.match(source, /assertInverseDirectPostcondition\(origin, target, bearingDegrees, distanceMeters\)/);
assert.match(source, /Geodesic\.WGS84\.Direct\(/);
assert.match(source, /normalizeSignedLongitudeDifferenceDegrees/);
assert.match(source, /Karney inverse\/direct postcondition failed/);

console.log("Karney coincident and antipodal postcondition source checks passed.");
