import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath } from "cesium";
globalThis.window ??= { setTimeout: globalThis.setTimeout };
import { calculateTripodCandidates, buildCelestialBackwardRay, rayCartographicAtDistance } from "../../src/cesium/tripodCandidates.ts";
import { calculateCelestialHorizontalCoordinates } from "../../src/cesium/celestial.ts";
import { calculateKarneyLineMetrics } from "../../src/geodesy/karneyGeodesic.ts";
import { ellipsoidalHeightMeters } from "../../src/types/points.ts";

const CAMERA = { focalLengthMm: 250, lensCenterHeightMeters: 1.6 };
const CALCULATION_MODE = "pro"; // production always uses pro
const DATE = new Date("2026-08-09T09:06:00.000Z"); // 18:06 JST = 09:06 UTC

// 実際の共有データから取得した本物の座標
const SUBJECT = {
  latitude: 35.35768320944909,
  longitude: 136.8090747234574,
  height: 900, // 標高は不明なので仮に900mとして試す(丘陵地帯を想定)
  ellipsoidalHeightMeters: 900,
  label: "手動指定地点",
};
const TRIPOD_REAL = {
  latitude: 35.35556780866144,
  longitude: 136.8194024751617,
  label: "三脚ピン",
  height: 900,
};

const realDistance = calculateKarneyLineMetrics(SUBJECT, TRIPOD_REAL).distanceMeters;
const realBearing = calculateKarneyLineMetrics(SUBJECT, TRIPOD_REAL).bearingDegrees;
console.log("real distance from subject to tripod:", realDistance, "bearing:", realBearing);

// 被写体地点から見た太陽の実際の方位・高度
const sunFromSubject = calculateCelestialHorizontalCoordinates("sun", DATE, SUBJECT, CALCULATION_MODE);
console.log("sun from subject: az=", sunFromSubject.azimuthDegrees, "alt=", sunFromSubject.altitudeDegrees);
console.log("expected tripod bearing (az+180):", (sunFromSubject.azimuthDegrees + 180) % 360);

// 被写体からのレイを構築し、実際の三脚地点(968m)でのレイの高さを求める
const ray = buildCelestialBackwardRay(SUBJECT, sunFromSubject.azimuthDegrees, sunFromSubject.altitudeDegrees);
const rayAtRealDistance = rayCartographicAtDistance(ray, realDistance);
console.log("ray height at real tripod distance:", rayAtRealDistance.height, "(subject height was", SUBJECT.height, ")");
console.log("implied tripod ground height (ray height - lens height):", rayAtRealDistance.height - CAMERA.lensCenterHeightMeters);

// 「地形がレイと完全に一致する」という理想的なモックで、実際に候補が見つかるか確認
function makeIdealTerrainSampler() {
  const subjectEcef = Cartesian3.fromDegrees(SUBJECT.longitude, SUBJECT.latitude, ellipsoidalHeightMeters(SUBJECT), Ellipsoid.WGS84);
  return async (points) => points.map((point) => {
    const queryEcef = Cartesian3.fromRadians(point.longitude, point.latitude, Number.isFinite(point.height) ? point.height : 0, Ellipsoid.WGS84);
    const distanceMeters = Cartesian3.distance(subjectEcef, queryEcef);
    const rayHeight = Number.isFinite(point.height) ? point.height : 0;
    // 地形 = レイの高さ - レンズ高 (完全に理想的な地形。真の交点は正確にrealDistanceにある)
    const height = rayHeight - CAMERA.lensCenterHeightMeters;
    return Cartographic.fromRadians(point.longitude, point.latitude, height);
  });
}

const point = { id: "sun", label: "太陽", azimuthDegrees: sunFromSubject.azimuthDegrees, altitudeDegrees: sunFromSubject.altitudeDegrees };
const candidates = await calculateTripodCandidates(
  SUBJECT, [point], CAMERA, DATE, CALCULATION_MODE, makeIdealTerrainSampler(), undefined, 3/2
);
console.log("candidates found:", candidates.length, candidates.map(c => ({d: c.distanceMeters, lat: c.latitude, lon: c.longitude})));
