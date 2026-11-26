import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { retiredVisibilityModulePaths, retiredVisibilityModuleSource } from "../../scripts/retired-visibility-files.mjs";

test("in-place upgrades overwrite retired candidate visibility modules with no executable code", () => {
  for (const file of retiredVisibilityModulePaths) {
    if (existsSync(file)) {
      assert.equal(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), retiredVisibilityModuleSource, file);
    }
  }
  const obsoleteDocumentation = "CANDIDATE_POINT_VISIBILITY_FEATURE.md";
  if (existsSync(obsoleteDocumentation)) {
    assert.equal(readFileSync(obsoleteDocumentation, "utf8").trim(),
      "見通し機能は廃止されました。このファイルは、旧版への上書き時に以前の説明を残さないために同梱しています。");
  }
});

test("candidate-point visibility execution routes stay removed", () => {
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
