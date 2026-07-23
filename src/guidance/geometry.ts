import type { GroundPoint } from "../types/points";

const EARTH_RADIUS_METERS = 6_371_008.8;

export function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function signedAngleDegrees(value: number): number {
  const normalized = normalizeDegrees(value);
  return normalized > 180 ? normalized - 360 : normalized;
}

export function guidanceDistanceMeters(
  origin: Pick<GroundPoint, "latitude" | "longitude">,
  target: Pick<GroundPoint, "latitude" | "longitude">
): number {
  const latitude1 = origin.latitude * Math.PI / 180;
  const latitude2 = target.latitude * Math.PI / 180;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (target.longitude - origin.longitude) * Math.PI / 180;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function guidanceBearingDegrees(
  origin: Pick<GroundPoint, "latitude" | "longitude">,
  target: Pick<GroundPoint, "latitude" | "longitude">
): number {
  const latitude1 = origin.latitude * Math.PI / 180;
  const latitude2 = target.latitude * Math.PI / 180;
  const longitudeDelta = (target.longitude - origin.longitude) * Math.PI / 180;
  return normalizeDegrees(Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(latitude2),
    Math.cos(latitude1) * Math.sin(latitude2) -
      Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta)
  ) * 180 / Math.PI);
}

export function cameraAltitudeToSubjectDegrees(
  tripod: GroundPoint,
  subject: GroundPoint,
  lensCenterHeightMeters: number
): number {
  const distance = Math.max(.01, guidanceDistanceMeters(tripod, subject));
  return Math.atan2(
    subject.height - tripod.height - lensCenterHeightMeters,
    distance
  ) * 180 / Math.PI;
}

export function localOffsetsMeters(
  origin: Pick<GroundPoint, "latitude" | "longitude">,
  target: Pick<GroundPoint, "latitude" | "longitude">
): { eastMeters: number; northMeters: number } {
  const latitudeRadians = origin.latitude * Math.PI / 180;
  return {
    eastMeters: (target.longitude - origin.longitude) *
      Math.cos(latitudeRadians) * 111_320,
    northMeters: (target.latitude - origin.latitude) * 110_574,
  };
}

export function offsetGroundPoint(
  origin: GroundPoint,
  eastMeters: number,
  northMeters: number,
  elevationMeters: number,
  label = origin.label
): GroundPoint {
  const latitudeRadians = origin.latitude * Math.PI / 180;
  return {
    latitude: origin.latitude + northMeters / 110_574,
    longitude: origin.longitude + eastMeters /
      Math.max(1, Math.cos(latitudeRadians) * 111_320),
    height: origin.height + elevationMeters,
    label,
  };
}

export function movementComponentsMeters(
  current: Pick<GroundPoint, "latitude" | "longitude">,
  target: Pick<GroundPoint, "latitude" | "longitude">,
  headingDegrees: number
): { forwardMeters: number; rightMeters: number } {
  const distance = guidanceDistanceMeters(current, target);
  const bearing = guidanceBearingDegrees(current, target);
  const relative = signedAngleDegrees(bearing - headingDegrees) * Math.PI / 180;
  return {
    forwardMeters: distance * Math.cos(relative),
    rightMeters: distance * Math.sin(relative),
  };
}
