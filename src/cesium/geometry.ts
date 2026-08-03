import { Cartesian3, Ellipsoid, Math as CesiumMath } from "cesium";

import type { GroundPoint } from "../types/points";
import { terrestrialRefractionCorrectionDegrees } from "../geodesy/terrestrialRefraction";

/**
 * WGS84楕円体上の観測点から対象点を見た仰角をECEF座標で求める。
 * 観測点のheightにはレンズ中心高を含めて渡す。
 *
 * 天体側の大気差補正との非対称性を避けるため、見通し距離に応じた
 * 地表屈折補正（平均k=0.13）を加える。近距離では無視できる大きさに
 * 自然に収束するため、既存の近距離被写体の挙動には実質影響しない。
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
  const geometricDegrees = CesiumMath.toDegrees(Math.asin(sine));
  const distanceMeters = Cartesian3.distance(observerPosition, targetPosition);
  return geometricDegrees + terrestrialRefractionCorrectionDegrees(distanceMeters);
}
