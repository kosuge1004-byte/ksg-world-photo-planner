import { calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import type { GroundPoint } from "../types/points";

/**
 * 指定座標が「三脚より奥、被写体より手前」の範囲にある場合だけ返す。
 * 有効なタップ位置は中心線へ吸着させず、その座標をそのまま保持する。
 */
export function foregroundCoordinatesWithinSegment(
  latitude: number,
  longitude: number,
  tripod: GroundPoint,
  subject: GroundPoint
): { latitude: number; longitude: number } | null {
  const line = calculateKarneyLineMetrics(tripod, subject);
  if (line.distanceMeters <= 0.02) return null;

  const pointer: GroundPoint = {
    latitude,
    longitude,
    height: tripod.height,
    label: "人物配置位置",
  };
  const pointerLine = calculateKarneyLineMetrics(tripod, pointer);
  const bearingDeltaRadians =
    (pointerLine.bearingDegrees - line.bearingDegrees) * Math.PI / 180;
  const projectedDistanceMeters =
    pointerLine.distanceMeters * Math.cos(bearingDeltaRadians);
  const crossTrackDistanceMeters = Math.abs(
    pointerLine.distanceMeters * Math.sin(bearingDeltaRadians)
  );

  // スマートフォンのタップ誤差を許容しつつ、三脚より後方・被写体より奥は除外する。
  const endpointClearanceMeters = Math.min(0.25, line.distanceMeters * 0.005);
  const corridorWidthMeters = Math.max(5, Math.min(30, line.distanceMeters * 0.2));
  const isBetween =
    projectedDistanceMeters >= endpointClearanceMeters &&
    projectedDistanceMeters <= line.distanceMeters - endpointClearanceMeters &&
    crossTrackDistanceMeters <= corridorWidthMeters;

  return isBetween ? { latitude, longitude } : null;
}
