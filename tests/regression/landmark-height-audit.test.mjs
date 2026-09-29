import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptLandmarkHeightAuditResult,
  auditLandmarkHeight,
} from "../../src/audit/landmarkHeightAudit.ts";
import { applyLandmarkHeightsToSource } from "../../scripts/lib/landmarkHeightApply.mjs";

const target = { name: "試験城", latitude: 35, longitude: 137 };
const point = (latitude, longitude, height) => ({
  latitude, longitude, height, ellipsoidalHeightMeters: height, orthometricHeightMeters: height - 38,
  geoidHeightMeters: 38, heightSource: "dem", label: "試験城",
});

test("height is measured against the same DEM ground the app uses, so a DEM platform is never double counted", async () => {
  // DEMが天守台上面(地表+10m)を持っている場合でも、頂上−登録座標地表 = アプリが足す高さ。
  const result = await auditLandmarkHeight(target, {
    resolveGround: async () => point(35, 137, 60),
    resolvePlateauTop: async () => point(35.00005, 137, 82),
    sampleRing: async (points) => points.map(() => 50),
  });
  assert.equal(result.status, "measured");
  assert.equal(result.heightMeters, 22);
  assert.equal(result.platformMeters, 10);
  assert.ok(result.topOffsetMeters < 6);
  assert.deepEqual(acceptLandmarkHeightAuditResult(result), { accepted: true, heightMeters: 22 });
});

test("a roof found on a neighbouring building or missing PLATEAU data is not adopted", async () => {
  const far = await auditLandmarkHeight(target, {
    resolveGround: async () => point(35, 137, 60),
    resolvePlateauTop: async () => point(35.0004, 137, 90),
    sampleRing: async (points) => points.map(() => 60),
  });
  assert.equal(acceptLandmarkHeightAuditResult(far).accepted, false);
  const none = await auditLandmarkHeight(target, {
    resolveGround: async () => point(35, 137, 60),
    resolvePlateauTop: async () => null,
    sampleRing: async (points) => points.map(() => 60),
  });
  assert.equal(none.status, "no-plateau-roof");
  assert.equal(acceptLandmarkHeightAuditResult(none).accepted, false);
});

test("applying heights only touches unverified rows with the exact name", () => {
  const source = [
    '  { name: "試験城", category: "castle", latitude: 35, longitude: 137, subjectSurface: "structure", heightMeters: null, heightStatus: "unverified" },',
    '  { name: "試験城跡", category: "castle", latitude: 35.1, longitude: 137, subjectSurface: "structure", heightMeters: null, heightStatus: "unverified" },',
    '  { name: "別城", category: "castle", latitude: 34, longitude: 136, subjectSurface: "structure", heightMeters: 20 },',
  ].join("\n");
  const { source: next, applied } = applyLandmarkHeightsToSource(source, new Map([["試験城", 22.04], ["別城", 30]]));
  assert.deepEqual(applied, ["試験城"]);
  assert.match(next, /name: "試験城", .*heightMeters: 22 \}/u);
  assert.match(next, /name: "試験城跡", .*heightStatus: "unverified"/u);
  assert.match(next, /name: "別城", .*heightMeters: 20 \}/u);
});
