// 2026-10-10（精度最優先）: ジオイド高は地点ごと、保存済み断面による近道は使わない、
// 精度の低い代替地形で求めた地点は三脚候補として確定しない。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Cartographic } from "cesium";

import { fetchGsiGeoidHeight, isLowPrecisionFallbackTerrainSample } from "../../src/cesium/worldTerrain.ts";
import { lookupLocalJpgeo2024Height } from "../../server/jpgeo2024Local.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("geoid height is taken at each point, not one value per 2.8 km cell", async () => {
  // 実機診断の2地点（三脚と被写体。約1.7km離れ、同じ0.025度格子に入る）。
  const tripod = [35.4361241, 136.76354232];
  const subject = [35.433918, 136.7820713];
  const cell = (value) => Math.round(value / 0.025) * 0.025;
  assert.equal(cell(tripod[0]), cell(subject[0]));
  assert.equal(cell(tripod[1]), cell(subject[1]));
  const atTripod = await fetchGsiGeoidHeight(Cartographic.fromDegrees(tripod[1], tripod[0]));
  const atSubject = await fetchGsiGeoidHeight(Cartographic.fromDegrees(subject[1], subject[0]));
  // 以前は同じ格子なので同じ値（診断では両方38.144m）になっていた。
  assert.equal(atTripod, lookupLocalJpgeo2024Height(tripod[0], tripod[1]));
  assert.equal(atSubject, lookupLocalJpgeo2024Height(subject[0], subject[1]));
  const difference = atSubject - atTripod;
  // 実際の差は約6cm。1.7km先の仰角で約0.002度（合否の基準と同じ大きさ）に相当する。
  assert.ok(difference > 0.05 && difference < 0.07, String(difference));
  const degrees = Math.atan(difference / 1700) * 180 / Math.PI;
  assert.ok(degrees > 0.0015, String(degrees));

  const source = await read("src/cesium/worldTerrain.ts");
  // 標高→楕円体高の変換（端末内の地形・通信で得た地形の両方）が地点ごとの値を使う。
  assert.equal((source.match(/await fetchGeoidHeightsForPoints\(/g) ?? []).length, 2);
  assert.match(source, /const geoidHeightMeters = localGeoidByIndex\.get\(localIndex\);/);
  assert.match(source, /const geoidHeightMeters = geoidHeightByIndex\.get\(index\);/);
  // 格子の代表値は、端末内のモデルで求められない地点の予備としてだけ残る。
  assert.match(source, /if \(local !== null\) heights\.set\(index, local\);\s*else regionalIndexes\.push\(index\);/);
});

test("a spot solved on the low-precision fallback terrain is never confirmed", async () => {
  // 出典が記録されていない標本（テスト用の地形など）は対象外。
  assert.equal(isLowPrecisionFallbackTerrainSample(Cartographic.fromDegrees(136.7, 35.4, 10)), false);
  const search = await read("src/cesium/tripodCandidates.ts");
  // 最終確認（仰角・方位0.002度）を通った後で、地形の出典を確認して棄却する。
  assert.match(search, /reject\("final-horizontal-not-converged"[\s\S]{0,400}?if \(isLowPrecisionFallbackTerrainSample\(solution\.cartographic\)\) \{\s*reject\("terrain-low-precision-source"/);
  const terrain = await read("src/cesium/worldTerrain.ts");
  assert.match(terrain, /return terrainSourceBySample\.get\(sample\) === "CESIUM_WORLD_TERRAIN";/);
  assert.match(terrain, /三脚候補として確定しません/);
});

test("tripod candidates always come from the full search (no shortcut through stored 1-degree sections)", async () => {
  const app = await read("src/App.tsx");
  assert.match(app, /const PRECISION_FIRST_FULL_SEARCH: boolean = true;/);
  assert.match(app, /const bearingProfileResult = PRECISION_FIRST_FULL_SEARCH \? null : await tryUseBearingProfileCache\(/);
  // 診断の「探索範囲: 狭域(一次)」は、値を設定する処理が無く常に同じ表示だったため削除した。
  assert.doesNotMatch(app, /狭域\(一次\)/);
});
