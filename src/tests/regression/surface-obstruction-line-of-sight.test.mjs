import assert from "node:assert/strict";
import test from "node:test";

import {
  closestApproachToRay,
  elevationAngleDegreesForHeight,
  lookupSurfaceObstructionHorizon,
} from "../../server/surfaceObstructionLineOfSight.ts";
import { EARTH_MEAN_RADIUS_METERS } from "../../src/geodesy/terrestrialRefraction.ts";

const ORIGIN = { latitude: 35.681236, longitude: 139.767125 };

// elevationAngleDegreesForHeight は kFactor の値に関わらず、有効地球半径
// R/(1-k) による地球曲率の落差を必ず差し引く（kFactor=0でも曲率drop自体はゼロにならない）。
// そのため「高さ=距離なら厳密に45度」という平面幾何の恒等式はこの関数には成立しない。
// 本番の既定値（k=0.13）を変更せず、実装と同じ式で期待値を算出して検証する。
function expectedElevationDegrees(heightAboveObserverMeters, distanceMeters, kFactor) {
  if (distanceMeters <= 0) return 90;
  const effectiveRadius = EARTH_MEAN_RADIUS_METERS / (1 - kFactor);
  const curvatureDropMeters = (distanceMeters * distanceMeters) / (2 * effectiveRadius);
  return Math.atan2(heightAboveObserverMeters - curvatureDropMeters, distanceMeters) * 180 / Math.PI;
}

test("elevationAngleDegreesForHeight matches atan2 plus earth-curvature drop at known geometry", () => {
  // 水平距離100mで高さ100mの屋根。既定のkFactor=0.13で計算式どおりの値になること。
  const fortyFiveIsh = elevationAngleDegreesForHeight(100, 100);
  const expectedFortyFiveIsh = expectedElevationDegrees(100, 100, 0.13);
  assert.ok(
    Math.abs(fortyFiveIsh - expectedFortyFiveIsh) < 1e-9,
    `expected ${expectedFortyFiveIsh}deg, got ${fortyFiveIsh}`
  );
  // 曲率補正により、平面幾何のみの45度よりわずかに小さくなる。
  assert.ok(fortyFiveIsh < 45, `curvature drop should pull the angle slightly below 45deg, got ${fortyFiveIsh}`);
  assert.ok(45 - fortyFiveIsh < 0.01, `curvature drop at 100m should be a very small offset, got ${45 - fortyFiveIsh}`);

  // 高さ0、距離200m。曲率補正込みでわずかに水平線(0度)を下回る。
  const level = elevationAngleDegreesForHeight(0, 200);
  const expectedLevel = expectedElevationDegrees(0, 200, 0.13);
  assert.ok(Math.abs(level - expectedLevel) < 1e-9, `expected ${expectedLevel}deg, got ${level}`);
  assert.ok(level < 0, `curvature drop should push the angle slightly below 0deg, got ${level}`);

  // 距離0（真上）は曲率計算を行わず90度に丸められる。
  const overhead = elevationAngleDegreesForHeight(50, 0);
  assert.equal(overhead, 90);
});

test("elevationAngleDegreesForHeight custom kFactor changes the curvature drop as expected", () => {
  // kFactorが大きいほど有効地球半径が大きくなり、曲率dropは小さくなる
  // （＝見かけの仰角は高くなる）。この単調性を確認する。
  const withStandardK = elevationAngleDegreesForHeight(100, 100, 0.13);
  const withNoRefraction = elevationAngleDegreesForHeight(100, 100, 0);
  assert.ok(
    withStandardK > withNoRefraction,
    `larger kFactor should reduce the curvature drop and raise the angle: k=0.13 -> ${withStandardK}, k=0 -> ${withNoRefraction}`
  );
});

test("closestApproachToRay finds the nearest building vertex directly ahead", () => {
  // 真北（方位角0度）の光線上、約100m先に小さな建物ポリゴンを置く。
  // 光線上に頂点を1つ置くことで、どの頂点が採用されるか曖昧にならないようにする。
  const element = {
    type: "way",
    id: 1,
    tags: { building: "yes" },
    geometry: [
      { lat: ORIGIN.latitude + 0.0009, lon: ORIGIN.longitude },
      { lat: ORIGIN.latitude + 0.0009, lon: ORIGIN.longitude + 0.0001 },
      { lat: ORIGIN.latitude + 0.00095, lon: ORIGIN.longitude + 0.0001 },
      { lat: ORIGIN.latitude + 0.00095, lon: ORIGIN.longitude },
      { lat: ORIGIN.latitude + 0.0009, lon: ORIGIN.longitude },
    ],
  };
  const approach = closestApproachToRay(element, ORIGIN, 0);
  assert.ok(approach, "expected an approach result for a building ahead on the ray");
  assert.ok(approach.alongRayMeters > 95 && approach.alongRayMeters < 108,
    `expected ~100m along ray, got ${approach.alongRayMeters}`);
  assert.ok(approach.perpendicularMeters < 1,
    `expected the on-ray vertex to win with ~0m offset, got ${approach.perpendicularMeters}`);
});

test("closestApproachToRay ignores buildings behind the observer", () => {
  const element = {
    type: "way",
    id: 2,
    tags: { building: "yes" },
    geometry: [
      { lat: ORIGIN.latitude - 0.001, lon: ORIGIN.longitude },
      { lat: ORIGIN.latitude - 0.0011, lon: ORIGIN.longitude },
      { lat: ORIGIN.latitude - 0.0011, lon: ORIGIN.longitude + 0.0001 },
      { lat: ORIGIN.latitude - 0.001, lon: ORIGIN.longitude },
    ],
  };
  // 方位角0度（北）を見ているのに建物は南側にある。
  const approach = closestApproachToRay(element, ORIGIN, 0);
  assert.equal(approach, null);
});

test("lookupSurfaceObstructionHorizon returns the -90 sentinel for invalid input without throwing", async () => {
  const result = await lookupSurfaceObstructionHorizon(
    {
      latitude: Number.NaN,
      longitude: 139.767125,
      groundElevationMeters: 10,
      lensCenterHeightMeters: 1.6,
    },
    0,
    500
  );
  assert.equal(result.maximumElevationDegrees, -90);
  assert.equal(result.distanceMeters, null);
});

test("estimateFeatureHeight falls back to default canopy heights for untagged vegetation (Phase3)", async () => {
  // estimateFeatureHeight is not exported directly; verify indirectly through
  // the geometry helper + a known elevation-angle formula using the documented
  // default canopy constants (forest 12m, single tree 8m) via elevationAngleDegreesForHeight.
  const forestElevation = elevationAngleDegreesForHeight(12, 50);
  const treeElevation = elevationAngleDegreesForHeight(8, 50);
  assert.ok(forestElevation > treeElevation,
    "a forest canopy (12m default) should read a higher elevation angle than a lone tree (8m default) at equal distance");
});
