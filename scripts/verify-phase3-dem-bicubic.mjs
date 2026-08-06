import assert from "node:assert/strict";
import fs from "node:fs";

const gsi = fs.readFileSync(new URL("../server/gsiElevation.ts", import.meta.url), "utf8");
const bicubic = fs.readFileSync(new URL("../server/constrainedBicubicInterpolation.ts", import.meta.url), "utf8");

assert.match(gsi, /function rawHeightAcrossTiles\(/);
assert.match(gsi, /tileKeyFor\(/);
assert.match(gsi, /normalizeTileX\(/);
assert.match(gsi, /point\.maximumDetail === "1m"/);
assert.match(gsi, /isUsableBicubicGrid\(rows\)/);
assert.match(gsi, /return bilinear;/);
assert.doesNotMatch(gsi, /rawHeightAt\(tile, pixelX \+ offsetX/);
assert.match(bicubic, /Math\.max\(minimum, Math\.min\(maximum, raw\)\)/);
assert.match(bicubic, /value !== null && Number\.isFinite\(value\)/);

console.log("phase3 DEM bicubic verification passed");
