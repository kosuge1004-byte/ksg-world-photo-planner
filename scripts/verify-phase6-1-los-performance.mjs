import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const terrain = await readFile(new URL("../src/geodesy/adaptiveTerrainProfile.ts", import.meta.url), "utf8");
const evaluator = await readFile(new URL("../server/celestialTerrainVisibility.ts", import.meta.url), "utf8");
const surface = await readFile(new URL("../server/surfaceObstructionLineOfSight.ts", import.meta.url), "utf8");

assert.match(terrain, /const target = new Cartesian3\(\)/, "LOS loop must reuse target Cartesian3");
assert.match(terrain, /const direction = new Cartesian3\(\)/, "LOS loop must reuse direction Cartesian3");
assert.match(terrain, /const count = Math\.min\(samples\.length, distances\.length\)/, "LOS loop must guard mismatched arrays");

// Current policy: server LOS must use DEM terrain only. OSM building/vegetation
// obstruction remains in the source tree for possible future use, but must not be
// imported or executed from the active celestial visibility path.
assert.doesNotMatch(
  evaluator,
  /from ["']\.\/surfaceObstructionLineOfSight\.ts["']/,
  "active evaluator must not import OSM building/vegetation LOS"
);
assert.doesNotMatch(
  evaluator,
  /lookupSurfaceObstructionHorizon\s*\(/,
  "active evaluator must not execute OSM building/vegetation LOS"
);
assert.match(evaluator, /pendingTerrainHorizon/, "terrain LOS promise must remain active");
assert.match(
  evaluator,
  /awaitWithAbort\(pendingTerrainHorizon, signal\)/,
  "terrain LOS must remain abortable"
);
assert.match(
  evaluator,
  /reason:\s*terrainObstructed\s*\?\s*["']terrain["']\s*:\s*["']visible["']/,
  "server LOS result must be based on DEM terrain only"
);

// The dormant module is intentionally retained so restoring the feature later
// does not require reconstructing it from scratch.
assert.match(surface, /export async function lookupSurfaceObstructionHorizon\(/, "surface LOS module should remain available but dormant");

console.log("Phase6-1 DEM-only LOS performance verification passed");
