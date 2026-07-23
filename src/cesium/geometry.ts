import { Cartesian3, Ellipsoid, Math as CesiumMath } from "cesium";

import type { GroundPoint } from "../types/points";

/**
 * WGS84楕円体上の観測点から対象点を見た仰角をECEF座標で求める。
 * 観測点のheightにはレンズ中心高を含めて渡す。
 */
export function calculateElevationAngleDegrees(
  observer: GroundPoint,
  target: GroundPoint
): number {
  const observerPosition = Cartesian3.fromDegrees(
    observer.longitude,
    observer.latitude,
    observer.height
  );
  const targetPosition = Cartesian3.fromDegrees(
    target.longitude,
    target.latitude,
    target.height
  );
  const direction = Cartesian3.normalize(
    Cartesian3.subtract(targetPosition, observerPosition, new Cartesian3()),
    new Cartesian3()
  );
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
    observerPosition,
    new Cartesian3()
  );
  const sine = Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp)));
  return CesiumMath.toDegrees(Math.asin(sine));
}
