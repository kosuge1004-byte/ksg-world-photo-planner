import assert from "node:assert/strict";
import test from "node:test";

import { classifyTerrainLineOfSight } from "../../src/search/spotPresetSearch.ts";

function occlusion(overrides) {
  return {
    verificationState: "dem-only",
    visible: true,
    verified: true,
    terrainObstructed: false,
    photorealisticMeshObstructed: false,
    reason: "visible",
    ...overrides,
  };
}

test("verified DEM terrain obstruction rejects a tripod candidate", () => {
  assert.deepEqual(classifyTerrainLineOfSight(occlusion({
    visible: false,
    terrainObstructed: true,
    reason: "terrain",
  })), {
    accepted: false,
    status: "possibly-obstructed",
  });
});

test("verified visible and unverified candidates keep their accuracy state", () => {
  assert.deepEqual(classifyTerrainLineOfSight(occlusion({})), {
    accepted: true,
    status: "visible",
  });
  assert.deepEqual(classifyTerrainLineOfSight(occlusion({
    verificationState: "failed",
    visible: false,
    verified: false,
    reason: "unverified",
  })), {
    accepted: true,
    status: "unverified",
  });
});

