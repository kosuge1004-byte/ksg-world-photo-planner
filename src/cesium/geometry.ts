import { Cartesian3, Ellipsoid, Math as CesiumMath } from "cesium";

import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters } from "../types/points";
import {
  assertDistanceMeters,
  assertEcefPosition,
  assertGroundPoint,
  assertPitchDegrees,
} from "../validation/validationService";

/**
 * Geometry層: WGS84楕円体上の観測点から対象点を見た仰角をECEF座標で求める。
 * 観測点のheightにはレンズ中心高を含めて渡す。
 *
 * この関数は純粋な幾何仰角のみを返す。地表屈折（大気補正）は見かけ値であり
 * Geometry層では一切加えない。屈折を加えた見かけ仰角が必要な場合は
 * `src/apparent/apparentElevation.ts` の `computeApparentElevation()` を使う。
 */
export type GeometricElevationResult = {
  geometricAltitudeDegrees: number;
  /** ECEF直線距離（斜距離）。Apparent層の屈折補正はこの距離を使う。 */
  slantDistanceMeters: number;
};

export function calculateGeometricElevation(
  observer: GroundPoint,
  target: GroundPoint
): GeometricElevationResult {
  // ValidationServiceで入力を検証してから計算経路へ入る。高度未確定・NaN・
  // 範囲外はここで停止し、0mフォールバックしない。
  assertGroundPoint(observer, observer?.label ?? "観測点");
  assertGroundPoint(target, target?.label ?? "対象点");
  const observerPosition = Cartesian3.fromDegrees(
    observer.longitude,
    observer.latitude,
    ellipsoidalHeightMeters(observer)
  );
  const targetPosition = Cartesian3.fromDegrees(
    target.longitude,
    target.latitude,
    ellipsoidalHeightMeters(target)
  );
  assertEcefPosition(observerPosition, `${observer.label || "観測点"}のECEF座標`);
  assertEcefPosition(targetPosition, `${target.label || "対象点"}のECEF座標`);
  const direction = Cartesian3.normalize(
    Cartesian3.subtract(targetPosition, observerPosition, new Cartesian3()),
    new Cartesian3()
  );
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
    observerPosition,
    new Cartesian3()
  );
  const sine = Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp)));
  const geometricAltitudeDegrees = CesiumMath.toDegrees(Math.asin(sine));
  const slantDistanceMeters = Cartesian3.distance(observerPosition, targetPosition);
  assertPitchDegrees(geometricAltitudeDegrees, "幾何仰角");
  assertDistanceMeters(slantDistanceMeters, "観測点と対象点の斜距離");
  return { geometricAltitudeDegrees, slantDistanceMeters };
}

