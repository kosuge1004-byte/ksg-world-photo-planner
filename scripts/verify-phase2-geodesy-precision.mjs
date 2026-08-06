import assert from "node:assert/strict";
import fs from "node:fs";

const karney = fs.readFileSync("src/geodesy/karneyGeodesic.ts", "utf8");
const points = fs.readFileSync("src/types/points.ts", "utf8");
const siteContext = fs.readFileSync("src/search/siteContext.ts", "utf8");
const gsiElevation = fs.readFileSync("functions/api/gsi-elevation.ts", "utf8");
const osmApi = fs.readFileSync("functions/api/osm-site-context.ts", "utf8");
const focal = fs.readFileSync("src/utils/focalLengthInput.ts", "utf8");
const camera = fs.readFileSync("src/cesium/camera.ts", "utf8");
const precisionStorage = fs.readFileSync("src/precision/precisionSettingsStorage.ts", "utf8");

assert.match(karney, /COINCIDENT_DISTANCE_EPSILON_METERS\s*=\s*1e-6/);
assert.match(karney, /bearingDefined:\s*false/);
assert.match(karney, /coincident:\s*true/);
assert.match(karney, /bearingDefined:\s*true/);
assert.match(points, /bearingDefined\?:\s*boolean/);
assert.match(points, /coincident\?:\s*boolean/);

assert.match(siteContext, /latitude:\s*point\.latitude/);
assert.match(siteContext, /longitude:\s*point\.longitude/);
assert.match(siteContext, /cacheKeyPoints/);
assert.match(gsiElevation, /lookupGsiElevations\(points/);
assert.match(gsiElevation, /cacheKeyInput/);
assert.match(osmApi, /lookupOsmSiteContexts\(points/);
assert.match(osmApi, /cacheKeyInput/);

for (const [name, source] of Object.entries({ focal, camera, precisionStorage })) {
  assert.doesNotMatch(source, /Float32Array/);
  assert.doesNotMatch(source, /parseInt\s*\(/);
}
assert.match(focal, /const value = Number\(normalized\)/);
assert.match(camera, /2 \* Math\.atan\(/);
assert.match(precisionStorage, /JSON\.stringify\(normalizePrecisionSettings\(settings\)\)/);

console.log("Phase 2 geodesy and precision source verification passed.");
