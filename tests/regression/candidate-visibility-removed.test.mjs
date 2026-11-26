import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const removedFiles = [
  "CANDIDATE_POINT_VISIBILITY_FEATURE.md",
  "src/visibility/candidatePointVisibilityFeature.ts",
  "src/visibility/candidatePointVisibility.ts",
  "src/types/candidatePointVisibility.ts",
  "src/cesium/candidatePointVisibilityEntities.ts",
  "functions/api/candidate-point-visibility.ts",
  "tools/local-dem-server/plateauLineOfSight.ts",
];

test("candidate-point visibility files and execution routes stay removed", () => {
  for (const file of removedFiles) {
    assert.equal(existsSync(file), false, `${file} must stay removed`);
  }
  for (const file of [
    "src/App.tsx",
    "src/components/Map2DOverlay.tsx",
    "src/components/DisplayGuide.tsx",
    "src/components/TopSettingsBar.tsx",
    "server/localDemGateway.ts",
    "tools/local-dem-server/app.ts",
    "tools/local-dem-server/server.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /CandidatePointVisibility|candidatePointVisibility|candidate-point-visibility/);
    assert.doesNotMatch(source, /\/v1\/plateau\/line-of-sight|◎ 見通し|見通し確認済み/);
  }
});
