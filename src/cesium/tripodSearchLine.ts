import type { CelestialBodyId, CelestialScreenPoint, CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";

const EARTH_RADIUS_METERS = 6_371_008.8;
export const TRIPOD_SEARCH_BASE_LINE_DISTANCE_METERS = 250_000;

export type TripodSearchBaseLine = {
  id: CelestialBodyId;
  label: string;
  bearingDegrees: number;
  start: GroundPoint;
  end: GroundPoint;
};

function destinationGroundPoint(
  origin: GroundPoint,
  bearingDegrees: number,
  distanceMeters: number
): GroundPoint {
  const bearing = bearingDegrees * Math.PI / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitude = origin.latitude * Math.PI / 180;
  const longitude = origin.longitude * Math.PI / 180;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const destinationLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) -
      Math.sin(latitude) * Math.sin(destinationLatitude)
  );

  return {
    latitude: destinationLatitude * 180 / Math.PI,
    longitude: destinationLongitude * 180 / Math.PI,
    height: origin.height + 0.2,
    label: `${origin.label ?? "被写体"}からの三脚探索基礎ライン終端`,
  };
}

/**
 * 地面投影ラインと将来の三脚候補ラインが共有する唯一の基礎ラインを生成する。
 * 天体の方位を被写体側へ180°反転し、被写体から三脚側へ地表上を延長する。
 */
export function buildTripodSearchBaseLines(
  subject: GroundPoint | null,
  points: CelestialScreenPoint[],
  visibility: CelestialVisibility
): TripodSearchBaseLine[] {
  if (!subject) return [];

  return points.flatMap((point) => {
    if (!visibility[point.id] || point.altitudeDegrees <= 0) return [];
    const bearingDegrees = (point.azimuthDegrees + 180) % 360;
    return [{
      id: point.id,
      label: point.label,
      bearingDegrees,
      start: subject,
      end: destinationGroundPoint(
        subject,
        bearingDegrees,
        TRIPOD_SEARCH_BASE_LINE_DISTANCE_METERS
      ),
    }];
  });
}
