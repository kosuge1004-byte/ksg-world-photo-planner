import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const terrain = await readFile(new URL("../src/geodesy/adaptiveTerrainProfile.ts", import.meta.url), "utf8");
const evaluator = await readFile(new URL("../server/celestialTerrainVisibility.ts", import.meta.url), "utf8");
const surface = await readFile(new URL("../server/surfaceObstructionLineOfSight.ts", import.meta.url), "utf8");

assert.match(terrain, /const target = new Cartesian3\(\)/, "LOS loop must reuse target Cartesian3");
assert.match(terrain, /const direction = new Cartesian3\(\)/, "LOS loop must reuse direction Cartesian3");
assert.match(terrain, /const count = Math\.min\(samples\.length, distances\.length\)/, "LOS loop must guard mismatched arrays");
assert.match(evaluator, /Promise\.all\(\[/, "DEM and surface LOS must run in parallel");
assert.match(evaluator, /pendingTerrainHorizon/, "terrain LOS promise must be started before join");
assert.match(evaluator, /pendingSurfaceHorizon/, "surface LOS promise must be started before join");
assert.match(surface, /computeSurfaceObstructionHorizon\(origin, azimuthDegrees, maximumDistanceMeters\)/, "shared surface cache must not inherit caller abort signal");
assert.match(surface, /return await awaitWithAbort\(pending, signal\)/, "surface LOS caller must remain abortable");

console.log("Phase6-1 LOS performance verification passed");
