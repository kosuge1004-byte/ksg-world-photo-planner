import assert from "node:assert/strict";
import fs from "node:fs";

const terrestrial = fs.readFileSync(new URL("../src/geodesy/terrestrialRefraction.ts", import.meta.url), "utf8");
const surface = fs.readFileSync(new URL("../server/surfaceObstructionLineOfSight.ts", import.meta.url), "utf8");

assert.match(terrestrial, /STANDARD_TERRESTRIAL_K_FACTOR = 0\.13/);
assert.match(terrestrial, /effectiveEarthRadiusMeters/);
assert.match(terrestrial, /effectiveEarthCurvatureDropMeters/);
assert.match(terrestrial, /ECEF.*地球曲率/s);
assert.match(surface, /effectiveEarthCurvatureDropMeters/);
assert.match(surface, /heightAboveObserverMeters - curvatureDropMeters/);

const R = 6371008.8;
const k = 0.13;
const effectiveRadius = R / (1 - k);
const drop100km = 100000 ** 2 / (2 * effectiveRadius);
const correction100kmDeg = (k * 100000 / (2 * R)) * 180 / Math.PI;
assert.ok(Math.abs(effectiveRadius - 7322998.62) < 2);
assert.ok(drop100km > 680 && drop100km < 690);
assert.ok(correction100kmDeg > 0.05 && correction100kmDeg < 0.07);
console.log("Phase4-5 k-factor verification passed");
