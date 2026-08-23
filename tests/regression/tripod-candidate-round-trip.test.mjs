import assert from "node:assert/strict";
import test from "node:test";
import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath } from "cesium";

globalThis.window ??= { setTimeout: globalThis.setTimeout };

import {
  calculateTripodCandidates,
  buildCelestialBackwardRay,
  buildCandidateGroundPoint,
  rayCartographicAtDistance,
} from "../../src/cesium/tripodCandidates.ts";
import {
  calculateCelestialHorizontalCoordinates,
  createCameraProjection,
  projectHorizontalToPreview,
} from "../../src/cesium/celestial.ts";
import { computeApparentElevation } from "../../src/apparent/apparentElevation.ts";
import { calculateKarneyLineMetrics } from "../../src/geodesy/karneyGeodesic.ts";
import { ellipsoidalHeightMeters } from "../../src/types/points.ts";

// AstroSight Claude引き継ぎ資料（三脚候補点修正）仕様7の自動テスト。
// - tripod candidate round-trip projection test
// - multiple terrain intersections test
// - no-FOV-rejection test
// - double-check isolation test
// - ellipsoidal/orthometric/geoid height consistency test

const CAMERA = { focalLengthMm: 200, lensCenterHeightMeters: 1.6 };
const CALCULATION_MODE = "standard";
const DATE = new Date("2026-08-20T09:00:00.000Z");

const SUBJECT = {
  latitude: 35.3606,
  longitude: 138.7274,
  height: 1000,
  ellipsoidalHeightMeters: 1000,
  label: "被写体",
};

/**
 * 被写体から見た実際の天体（太陽）方位・高度を取得する。
 * 数値そのものは何でもよく、地平線上（altitude > 0.25度）でありさえすれば
 * 以降のテストの前提を満たす。
 */
function realSunHorizontal() {
  return calculateCelestialHorizontalCoordinates(
    "sun",
    DATE,
    SUBJECT,
    CALCULATION_MODE
  );
}

/**
 * 合成地形サンプラー。
 *
 * 誤差 = (レイ楕円体高 - レンズ中心高) - 地形高 は、tripodCandidates.ts
 * 内部のsampleRayTerrainErrors()と同じ定義。地形高を
 * 「(レイの高さ - レンズ中心高) - bumpMeters(距離)」として構成するため、
 * このモックが返す誤差は常に bumpMeters(距離) そのものになる
 * （観測点の方位・高度の値やレンズ高に依存せず、交点位置を自由に設計できる）。
 *
 * 「距離」は被写体からのECEF直線距離（レイのパラメータt、
 * tripodCandidates.ts側の候補distanceMetersと同じ定義）で測る。
 * Karney測地線距離（水平成分中心）ではなく、実装が実際に使っている
 * 3D直線距離と揃えることで、テストの想定距離と実装の収束距離を一致させる。
 */
function makeMockTerrainSampler(subject, lensCenterHeightMeters, bumpMeters) {
  const subjectEcef = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    ellipsoidalHeightMeters(subject),
    Ellipsoid.WGS84
  );
  return async (points) => {
    return points.map((point) => {
      const queryEcef = Cartesian3.fromRadians(
        point.longitude,
        point.latitude,
        Number.isFinite(point.height) ? point.height : 0,
        Ellipsoid.WGS84
      );
      const distanceMeters = Cartesian3.distance(subjectEcef, queryEcef);
      const rayHeight = Number.isFinite(point.height) ? point.height : 0;
      const height = (rayHeight - lensCenterHeightMeters) - bumpMeters(distanceMeters);
      return Cartographic.fromRadians(point.longitude, point.latitude, height);
    });
  };
}

test("tripod candidate round-trip: candidate reproduces subject/celestial alignment through the same CameraModel/Projection path as the preview", async () => {
  const sun = realSunHorizontal();
  const point = { id: "sun", label: "太陽", azimuthDegrees: sun.azimuthDegrees, altitudeDegrees: sun.altitudeDegrees };

  // 単一の交点（距離500m）だけを持つ地形。
  const terrainSampler = makeMockTerrainSampler(SUBJECT, CAMERA.lensCenterHeightMeters, (d) => d - 500);

  const candidates = await calculateTripodCandidates(
    SUBJECT,
    [point],
    CAMERA,
    DATE,
    CALCULATION_MODE,
    terrainSampler,
    undefined,
    3 / 2,
    { minMeters: 100, maxMeters: 1000 }
  );

  assert.equal(candidates.length, 1, "単一交点の地形からは候補が1件だけ得られるべき");
  const candidate = candidates[0];
  assert.ok(Math.abs(candidate.distanceMeters - 500) < 1, `距離は500m付近であるべき（実際: ${candidate.distanceMeters}）`);

  // Round-trip: 候補地点をプレビューと同じCameraModel/Projection経路へ
  // 逆投入し、天体中心が画面中央（＝被写体中心）と一致することを確認する。
  const candidatePoint = {
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    height: candidate.height,
    ellipsoidalHeightMeters: candidate.height,
    label: "検証用三脚候補",
  };
  const projection = createCameraProjection(candidatePoint, SUBJECT, CAMERA, 3 / 2, CALCULATION_MODE);
  const finalHorizontal = calculateCelestialHorizontalCoordinates(
    "sun",
    DATE,
    {
      ...candidatePoint,
      height: candidatePoint.height + CAMERA.lensCenterHeightMeters,
      ellipsoidalHeightMeters: candidatePoint.ellipsoidalHeightMeters + CAMERA.lensCenterHeightMeters,
      label: "検証用三脚候補レンズ中心",
    },
    CALCULATION_MODE
  );
  const screen = projectHorizontalToPreview(finalHorizontal, projection);
  assert.ok(screen.inFront, "天体はカメラの前方にあるべき");
  assert.ok(Math.abs(screen.xPercent - 50) < 0.5, `天体は画面中央付近(x)にあるべき（実際: ${screen.xPercent}%）`);
  assert.ok(Math.abs(screen.yPercent - 50) < 0.5, `天体は画面中央付近(y)にあるべき（実際: ${screen.yPercent}%）`);

  // 幾何的にも、候補地点から見た被写体の方位・仰角が天体のそれと一致すること。
  const subjectBearing = calculateKarneyLineMetrics(candidatePoint, SUBJECT).bearingDegrees;
  const subjectElevation = computeApparentElevation(
    {
      ...candidatePoint,
      height: candidatePoint.height + CAMERA.lensCenterHeightMeters,
      ellipsoidalHeightMeters: candidatePoint.ellipsoidalHeightMeters + CAMERA.lensCenterHeightMeters,
    },
    SUBJECT,
    CALCULATION_MODE
  ).apparentAltitudeDegrees;
  assert.ok(
    Math.abs(((subjectBearing - finalHorizontal.azimuthDegrees + 540) % 360) - 180) < 0.01,
    "候補地点から被写体への方位は天体方位と一致するべき"
  );
  assert.ok(
    Math.abs(subjectElevation - finalHorizontal.altitudeDegrees) < 0.01,
    "候補地点から見た被写体の仰角は天体高度と一致するべき"
  );
});

test("multiple terrain intersections: both crossings are kept as separate candidates, not merged into one", async () => {
  const sun = realSunHorizontal();
  const point = { id: "sun", label: "太陽", azimuthDegrees: sun.azimuthDegrees, altitudeDegrees: sun.altitudeDegrees };

  // 300mと700mの2箇所で交差する地形（(d-300)(d-700)は区間内で負、区間外で正）。
  const terrainSampler = makeMockTerrainSampler(SUBJECT, CAMERA.lensCenterHeightMeters, (d) => (d - 300) * (d - 700) / 10000);

  const candidates = await calculateTripodCandidates(
    SUBJECT,
    [point],
    CAMERA,
    DATE,
    CALCULATION_MODE,
    terrainSampler,
    undefined,
    3 / 2,
    { minMeters: 100, maxMeters: 1000 }
  );

  assert.equal(candidates.length, 2, `2つの交点はどちらも候補として保持されるべき（実際: ${candidates.length}件）`);
  const distances = candidates.map((c) => c.distanceMeters).sort((a, b) => a - b);
  assert.ok(Math.abs(distances[0] - 300) < 2, `1つ目の交点は300m付近（実際: ${distances[0]}）`);
  assert.ok(Math.abs(distances[1] - 700) < 2, `2つ目の交点は700m付近（実際: ${distances[1]}）`);
  // 遠い候補から並ぶ（intersectionIndex 1が一番遠い距離）。
  const sortedByDescendingDistance = [...candidates].sort((a, b) => b.distanceMeters - a.distanceMeters);
  assert.deepEqual(
    sortedByDescendingDistance.map((c) => c.intersectionIndex),
    [1, 2]
  );
});

test("no FOV rejection: candidate distances are unaffected by focal length / aspect ratio (composition is a user decision, not a filter)", async () => {
  const sun = realSunHorizontal();
  const point = { id: "sun", label: "太陽", azimuthDegrees: sun.azimuthDegrees, altitudeDegrees: sun.altitudeDegrees };
  const terrainSampler = makeMockTerrainSampler(SUBJECT, 1.6, (d) => d - 500);

  const wideCandidates = await calculateTripodCandidates(
    SUBJECT,
    [point],
    { focalLengthMm: 24, lensCenterHeightMeters: 1.6 },
    DATE,
    CALCULATION_MODE,
    terrainSampler,
    undefined,
    3 / 2,
    { minMeters: 100, maxMeters: 1000 }
  );
  const teleCandidates = await calculateTripodCandidates(
    SUBJECT,
    [point],
    { focalLengthMm: 800, lensCenterHeightMeters: 1.6 },
    DATE,
    CALCULATION_MODE,
    terrainSampler,
    undefined,
    2 / 3,
    { minMeters: 100, maxMeters: 1000 }
  );

  assert.equal(wideCandidates.length, teleCandidates.length, "画角によって候補数が変わってはならない");
  assert.ok(
    Math.abs(wideCandidates[0].distanceMeters - teleCandidates[0].distanceMeters) < 1,
    "画角/焦点距離を理由に候補位置が変わってはならない"
  );
});

test("double-check isolation: enabling the legacy verification pass never alters the primary candidates", async () => {
  const sun = realSunHorizontal();
  const point = { id: "sun", label: "太陽", azimuthDegrees: sun.azimuthDegrees, altitudeDegrees: sun.altitudeDegrees };
  const terrainSampler = makeMockTerrainSampler(SUBJECT, CAMERA.lensCenterHeightMeters, (d) => d - 500);

  const withoutDoubleCheck = await calculateTripodCandidates(
    SUBJECT, [point], CAMERA, DATE, CALCULATION_MODE, terrainSampler, undefined, 3 / 2,
    { minMeters: 100, maxMeters: 1000 }, undefined, undefined, undefined, undefined, false
  );
  const withDoubleCheck = await calculateTripodCandidates(
    SUBJECT, [point], CAMERA, DATE, CALCULATION_MODE, terrainSampler, undefined, 3 / 2,
    { minMeters: 100, maxMeters: 1000 }, undefined, undefined, undefined, undefined, true
  );

  assert.deepEqual(
    withoutDoubleCheck.map((c) => ({ latitude: c.latitude, longitude: c.longitude, distanceMeters: c.distanceMeters })),
    withDoubleCheck.map((c) => ({ latitude: c.latitude, longitude: c.longitude, distanceMeters: c.distanceMeters })),
    "ダブルチェック（旧方式の独立検算）は本計算の候補を一切変更してはならない"
  );
});

test("ellipsoidal/orthometric/geoid height consistency: candidate ground points never silently substitute ellipsoidal height for orthometric height", () => {
  const subjectWithGeoid = {
    latitude: 35.3606,
    longitude: 138.7274,
    height: 1000,
    ellipsoidalHeightMeters: 1000,
    orthometricHeightMeters: 962,
    geoidHeightMeters: 38,
    heightSource: "dem",
    label: "被写体（ジオイド解決済み）",
  };
  const rayCartographic = Cartographic.fromDegrees(138.73, 35.365, 950);
  const candidate = buildCandidateGroundPoint(rayCartographic, subjectWithGeoid, "テスト候補");

  assert.equal(candidate.ellipsoidalHeightMeters, 950);
  assert.equal(candidate.geoidHeightMeters, 38, "被写体で解決済みのジオイド高を候補地点へ引き継ぐべき");
  assert.equal(
    candidate.orthometricHeightMeters,
    950 - 38,
    "標高（orthometric）は楕円体高からジオイド高を引いた値であるべき（楕円体高そのものを代用してはならない）"
  );

  // 被写体側にジオイド情報がない場合は、候補側でも明示的なorthometric/geoidを
  // 捏造しない（types/points.tsの通常フォールバックに委ねる）。
  const subjectWithoutGeoid = {
    latitude: 35.3606,
    longitude: 138.7274,
    height: 1000,
    label: "被写体（ジオイド未解決）",
  };
  const candidateWithoutGeoid = buildCandidateGroundPoint(rayCartographic, subjectWithoutGeoid, "テスト候補2");
  assert.equal(candidateWithoutGeoid.geoidHeightMeters, undefined);
  assert.equal(candidateWithoutGeoid.orthometricHeightMeters, undefined);
});

test("buildCelestialBackwardRay + rayCartographicAtDistance reproduce the WGS84-ellipsoid seed distance geometry", () => {
  const azimuthDegrees = 90;
  const altitudeDegrees = 30;
  const ray = buildCelestialBackwardRay(SUBJECT, azimuthDegrees, altitudeDegrees);
  assert.ok(ray, "有効な方位・高度からは常にレイが構成できるべき");

  // レイに沿って距離1mだけ進んだ点の楕円体高は、被写体の高さからおよそ
  // sin(高度) だけ下がるはず（レイは単位ベクトルなので、沿距離1mでの
  // 高さ変化は仰角のsin成分。近距離ではWGS84楕円体の曲率の影響は無視できる）。
  const oneMeterPoint = rayCartographicAtDistance(ray, 1);
  const expectedDrop = Math.sin(CesiumMath.toRadians(altitudeDegrees));
  const actualDrop = ellipsoidalHeightMeters(SUBJECT) - oneMeterPoint.height;
  assert.ok(
    Math.abs(actualDrop - expectedDrop) < 1e-6,
    `1m地点の高さ低下は sin(高度) に一致するべき（期待: ${expectedDrop}, 実際: ${actualDrop}）`
  );
});
