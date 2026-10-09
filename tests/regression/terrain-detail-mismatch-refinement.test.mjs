// 2026-10-10（精度最優先）: 三脚候補の交点探索は、最も細かい地形データ（1m）で行う。
// 10mデータと1mデータの高さが食い違う場所でも、粗探索の点に張り付かず、
// 1mデータ上の交点へ0.01m以内で収束する。10mデータに現れない交点も拾う。
import assert from "node:assert/strict";
import test from "node:test";

import { Cartesian3, Cartographic } from "cesium";

import {
  FINE_RESCAN_NEAR_METERS,
  FINE_RESCAN_STEP_METERS,
  buildCelestialBackwardRay,
  rayCartographicAtDistance,
  scanRayTerrainIntersections,
} from "../../src/cesium/tripodCandidates.ts";

const LENS = 1.6;
const GROUND = 56.905;
// 実機診断と同じ配置: 被写体（楕円体高389.767m）を、方位98.3度・高度11.18度の月と重ねる。
const subject = {
  latitude: 35.433918, longitude: 136.7820713, height: 389.767, ellipsoidalHeightMeters: 389.767,
  orthometricHeightMeters: 351.623, geoidHeightMeters: 38.144, heightSource: "dem", label: "被写体",
};
const ray = buildCelestialBackwardRay(subject, 98.303326, 11.182862);
const range = { minMeters: 8, maxMeters: 10_000 };
const distanceOf = (point) => Cartesian3.distance(
  ray.origin, Cartesian3.fromRadians(point.longitude, point.latitude, point.height)
);

/** 地面の高さを「距離の関数」で与える。10mデータと1mデータで別の関数にできる。 */
function sampler(coarseHeightAt, fineHeightAt, calls = []) {
  return async (points, _signal, maximumDetail) => {
    calls.push({ detail: maximumDetail, count: points.length });
    return points.map((point) => {
      const sample = Cartographic.clone(point);
      const distance = distanceOf(point);
      sample.height = maximumDetail === "1m" ? fineHeightAt(distance) : coarseHeightAt(distance);
      return sample;
    });
  };
}
const flat = (height) => () => height;
/** その距離で、レンズ中心がレイに乗る地面の高さとの差（0なら正解）。 */
function residual(solution, fineHeightAt) {
  const point = rayCartographicAtDistance(ray, solution.distanceMeters);
  return (point.height - LENS) - fineHeightAt(solution.distanceMeters);
}

test("identical 10m/1m data: one crossing, converged within 0.01 m", async () => {
  const solutions = await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), flat(GROUND)), undefined, range, undefined);
  assert.equal(solutions.length, 1);
  assert.ok(Math.abs(residual(solutions[0], flat(GROUND))) <= 0.01, String(residual(solutions[0], flat(GROUND))));
  assert.equal(solutions[0].cartographic.height, GROUND);
});

test("1m data differs from the 10m data by 1.4 to 40 m: converges on the 1m data within 0.01 m", async () => {
  for (const offset of [-40, -25, -12, -6, -3, -2, -1.4, 1.4, 2, 3, 6, 12, 25, 40]) {
    const fine = flat(GROUND + offset);
    const solutions = await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), fine), undefined, range, undefined);
    assert.equal(solutions.length, 1, `offset ${offset}`);
    // 合否の基準（仰角0.002度）は約1,700mで約0.06m。その6分の1以下まで詰める。
    const error = residual(solutions[0], fine);
    assert.ok(Math.abs(error) <= 0.01, `offset ${offset}: residual ${error}`);
    assert.ok(Math.abs(solutions[0].altitudeErrorDegrees) <= 0.01);
    // 候補地点の高さは1mデータの値（10mデータの高さを持ち込まない）。
    assert.equal(solutions[0].cartographic.height, GROUND + offset, `offset ${offset}`);
  }
});

test("a crossing that only exists in the 1m data (an embankment the 10m data does not show) is found", async () => {
  // 10mデータは平ら。1mデータには、平地の交点の手前（被写体側）に高さ3m・幅10mの堤防がある。
  const flatCrossing = (await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), flat(GROUND)), undefined, range, undefined))[0].distanceMeters;
  const bankFrom = flatCrossing - 20;
  const bankTo = flatCrossing - 10;
  const fine = (distance) => (distance >= bankFrom && distance <= bankTo ? GROUND + 3 : GROUND);
  const solutions = await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), fine), undefined, range, undefined);
  const onBank = solutions.filter((solution) => solution.cartographic.height === GROUND + 3);
  const onFlat = solutions.filter((solution) => solution.cartographic.height === GROUND);
  // 堤防の上（レイが堤防の天端を横切る点）と、従来の平地の交点の両方が候補になる。
  assert.ok(onBank.length >= 1, `solutions: ${solutions.map((s) => `${s.distanceMeters.toFixed(2)}@${s.cartographic.height}`).join(", ")}`);
  assert.ok(onFlat.some((solution) => Math.abs(solution.distanceMeters - flatCrossing) < 0.1));
  for (const solution of onBank) {
    assert.ok(solution.distanceMeters >= bankFrom && solution.distanceMeters <= bankTo);
  }
  // 堤防の天端を斜めに横切る交点は、0.01m以内まで収束している。
  assert.ok(onBank.some((solution) => Math.abs(residual(solution, fine)) <= 0.01));
});

test("crossings are searched on the 1m data: every near-ray stretch of the 10m data is re-measured at 1 m steps", async () => {
  const calls = [];
  await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), flat(GROUND - 2), calls), undefined, range, undefined);
  const fineCalls = calls.filter((call) => call.detail === "1m");
  // レイの下がり方は1mあたり約0.2m。高さの差が50m以内の範囲は前後 約250m ずつ。
  const slopePerMeter = Math.tan(11.182862 * Math.PI / 180);
  const expectedMinimum = 2 * FINE_RESCAN_NEAR_METERS / slopePerMeter / FINE_RESCAN_STEP_METERS;
  assert.ok(fineCalls[0].count >= expectedMinimum, `${fineCalls[0].count} >= ${expectedMinimum}`);
  assert.equal(FINE_RESCAN_STEP_METERS, 1);
  console.log(`fine samples: first scan ${fineCalls[0].count}, refinement ${fineCalls.slice(1).map((call) => call.count).join("+")}`);
});

test("re-convergence shortcut: same crossing as the full local scan, with fewer round trips", async () => {
  const { scanRayTerrainNearDistance, NEAR_RESCAN_HALF_WIDTH_METERS } = await import("../../src/cesium/tripodCandidates.ts");
  // 堤防つきの地形（1mデータにだけある起伏）で、平地の交点と堤防上の交点の両方を起点に試す。
  const flatCrossing = (await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), flat(GROUND)), undefined, range, undefined))[0].distanceMeters;
  // 実際の地形データは連続（格子点の間は補間）なので、堤防の斜面も連続にする（法面の幅3m）。
  const fine = (distance) => {
    const x = flatCrossing - distance; // 堤防は x = 10〜20m、その外側3mが法面
    const rise = Math.max(0, Math.min(1, (x - 7) / 3, (23 - x) / 3));
    return GROUND + 3 * rise;
  };
  const all = await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), fine), undefined, range, undefined);
  for (const start of all) {
    // 再収束と同じ条件: 前回の交点から数mずれた所を起点に、距離の±18%を局所範囲とする。
    for (const shift of [-6, -1.5, 0.4, 3, 9]) {
      const center = start.distanceMeters + shift;
      const span = Math.max(80, center * 0.18);
      const localRange = { minMeters: center - span, maxMeters: center + span };
      const profile = { sampleCount: 20 };
      const fullCalls = [];
      const full = await scanRayTerrainIntersections(ray, LENS, sampler(flat(GROUND), fine, fullCalls), undefined, localRange, profile, center, false);
      const nearCalls = [];
      const near = await scanRayTerrainNearDistance(ray, LENS, sampler(flat(GROUND), fine, nearCalls), undefined, center, localRange, profile);
      const nearest = (list) => list.reduce((best, item) =>
        Math.abs(item.distanceMeters - center) < Math.abs(best.distanceMeters - center) ? item : best);
      assert.ok(near && near.length > 0);
      // 「前回の交点に最も近い交点」は、近道でも通常の手順でも同じ場所（どちらも0.01m以内に収束）。
      const a = nearest(near);
      const b = nearest(full);
      assert.ok(Math.abs(a.distanceMeters - b.distanceMeters) < 0.11, `${a.distanceMeters} vs ${b.distanceMeters}`);
      assert.ok(Math.abs(a.cartographic.height - b.cartographic.height) < 0.02);
      assert.ok(Math.abs(a.altitudeErrorDegrees) <= 0.01 && Math.abs(b.altitudeErrorDegrees) <= 0.01);
      // 通信の往復（地形の取得回数）と取得点数は減る。10mデータの走査は行わない。
      assert.ok(nearCalls.length < fullCalls.length, `${nearCalls.length} < ${fullCalls.length}`);
      assert.ok(nearCalls.every((call) => call.detail === "1m"));
      const points = (calls) => calls.reduce((sum, call) => sum + call.count, 0);
      assert.ok(points(nearCalls) < points(fullCalls) / 3, `${points(nearCalls)} vs ${points(fullCalls)}`);
    }
  }
  // 前後40mに交点が無い時は null（呼び出し側が通常の手順で探すので結果は変わらない）。
  const far = flatCrossing + NEAR_RESCAN_HALF_WIDTH_METERS + 60;
  assert.equal(
    await scanRayTerrainNearDistance(ray, LENS, sampler(flat(GROUND), flat(GROUND)), undefined, far, { minMeters: far - 300, maxMeters: far + 300 }, undefined),
    null
  );
  const search = await (await import("node:fs/promises")).readFile(new URL("../../src/cesium/tripodCandidates.ts", import.meta.url), "utf8");
  assert.match(search, /const localSolutions = nearSolutions \?\? await scanRayTerrainIntersections\(/);
});
