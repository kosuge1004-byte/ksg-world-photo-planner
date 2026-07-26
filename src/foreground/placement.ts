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
    label: "前景移動位置",
  };
  const pointerLine = calculateKarneyLineMetrics(tripod, pointer);
  const bearingDeltaRadians =
    (pointerLine.bearingDegrees - line.bearingDegrees) * Math.PI / 180;
  const projectedDistanceMeters =
    pointerLine.distanceMeters * Math.cos(bearingDeltaRadians);
  const subjectDistance = calculateKarneyLineMetrics(pointer, subject);
  const endpointClearanceMeters = Math.min(0.5, line.distanceMeters * 0.01);
  const isBetween =
    projectedDistanceMeters > endpointClearanceMeters &&
    projectedDistanceMeters < line.distanceMeters - endpointClearanceMeters &&
    pointerLine.distanceMeters < line.distanceMeters &&
    subjectDistance.distanceMeters < line.distanceMeters;
  return isBetween ? { latitude, longitude } : null;
}
