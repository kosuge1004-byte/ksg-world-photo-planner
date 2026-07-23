import type { CelestialBodyId, CelestialScreenPoint, CelestialVisibility } from "../types/celestial";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import type { GroundPoint } from "../types/points";
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
  const destination = calculateKarneyDestinationPoint(
    origin,
    bearingDegrees,
    distanceMeters
  );

  return {
    ...destination,
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
