import { Cartesian3, Ellipsoid, Math as CesiumMath } from "cesium";

import type {
  GroundPoint,
  LineMetrics,
} from "../types/points";

const EARTH_RADIUS_METERS = 6371008.8;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function calculateLineMetrics(
  tripod: GroundPoint,
  subject: GroundPoint
): LineMetrics {
  const lat1 = toRadians(tripod.latitude);
  const lat2 = toRadians(subject.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(
    subject.longitude - tripod.longitude
  );

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLon / 2) ** 2;

  const horizontalDistance =
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) *
      Math.cos(lat2) *
      Math.cos(deltaLon);

  const bearing =
    (toDegrees(Math.atan2(y, x)) + 360) % 360;

  return {
    distanceMeters: horizontalDistance,
    bearingDegrees: bearing,
    heightDifferenceMeters: subject.height - tripod.height,
  };
}


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
