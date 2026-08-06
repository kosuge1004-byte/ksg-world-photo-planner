import geographicLibGeodesic from "geographiclib-geodesic";

const { Geodesic } = geographicLibGeodesic;

import type { GroundPoint, LineMetrics } from "../types/points";


export type GeodeticCoordinate = {
  latitude: number;
  longitude: number;
};

export type KarneySurfaceMetrics = {
  distanceMeters: number;
  bearingDegrees: number;
};

export const COINCIDENT_DISTANCE_EPSILON_METERS = 1e-6;
export const ANTIPODAL_POSTCONDITION_DISTANCE_METERS = 19_000_000;
export const GEODESIC_POSTCONDITION_TOLERANCE_DEGREES = 1e-8;

function assertFiniteNumber(value: unknown, valueName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${valueName} must be a finite number.`);
  }
}


function normalizeSignedLongitudeDifferenceDegrees(value: number): number {
  assertFiniteNumber(value, "longitude difference");
  return ((value + 540) % 360) - 180;
}

function assertInverseDirectPostcondition(
  origin: GeodeticCoordinate,
  target: GeodeticCoordinate,
  bearingDegrees: number,
  distanceMeters: number
): void {
  if (distanceMeters < ANTIPODAL_POSTCONDITION_DISTANCE_METERS) {
    return;
  }

  const direct = Geodesic.WGS84.Direct(
    origin.latitude,
    origin.longitude,
    bearingDegrees,
    distanceMeters,
    Geodesic.STANDARD
  );
  const latitude = direct.lat2;
  const longitude = direct.lon2;
  assertFiniteNumber(latitude, "Karney inverse/direct postcondition latitude");
  assertFiniteNumber(longitude, "Karney inverse/direct postcondition longitude");

  const latitudeErrorDegrees = Math.abs(latitude - target.latitude);
  const longitudeErrorDegrees = Math.abs(
    normalizeSignedLongitudeDifferenceDegrees(longitude - target.longitude)
  );

  if (
    latitudeErrorDegrees > GEODESIC_POSTCONDITION_TOLERANCE_DEGREES ||
    longitudeErrorDegrees > GEODESIC_POSTCONDITION_TOLERANCE_DEGREES
  ) {
    throw new Error(
      `Karney inverse/direct postcondition failed: latitude error ${latitudeErrorDegrees}°, ` +
        `longitude error ${longitudeErrorDegrees}°.`
    );
  }
}

function assertValidGeodeticCoordinate(
  coordinate: GeodeticCoordinate,
  coordinateName: string
): void {
  assertFiniteNumber(coordinate.latitude, `${coordinateName} latitude`);
  assertFiniteNumber(coordinate.longitude, `${coordinateName} longitude`);

  if (coordinate.latitude < -90 || coordinate.latitude > 90) {
    throw new Error(`${coordinateName} latitude must be between -90 and 90 degrees.`);
  }
}

/** 高度を含まない任意座標間のWGS84地表距離と初期方位角を返す。 */
export function calculateKarneySurfaceMetrics(
  origin: GeodeticCoordinate,
  target: GeodeticCoordinate
): KarneySurfaceMetrics {
  assertValidGeodeticCoordinate(origin, "Karney inverse origin");
  assertValidGeodeticCoordinate(target, "Karney inverse target");

  const result = Geodesic.WGS84.Inverse(
    origin.latitude,
    origin.longitude,
    target.latitude,
    target.longitude,
    Geodesic.STANDARD
  );

  const distanceMeters = result.s12;
  const initialBearingDegrees = result.azi1;

  assertFiniteNumber(distanceMeters, "Karney inverse distance result");
  assertFiniteNumber(initialBearingDegrees, "Karney inverse initial bearing result");

  if (distanceMeters < 0) {
    throw new Error("Karney inverse distance result must be non-negative.");
  }

  if (distanceMeters < COINCIDENT_DISTANCE_EPSILON_METERS) {
    // 同一点では方位角が数学的に不定。既存のnumber型APIを維持しつつ、
    // 距離ゼロのセンチネルとして0度を返す。呼び出し側は必ず距離を先に判定する。
    return { distanceMeters: 0, bearingDegrees: 0 };
  }

  const bearingDegrees = normalizeBearingDegrees(
    initialBearingDegrees,
    "Karney inverse initial bearing result"
  );
  assertInverseDirectPostcondition(origin, target, bearingDegrees, distanceMeters);

  return { distanceMeters, bearingDegrees };
}

/** WGS84楕円体上の地表距離だけが必要な処理向けの軽量ヘルパー。 */
export function calculateKarneySurfaceDistanceMeters(
  origin: GeodeticCoordinate,
  target: GeodeticCoordinate
): number {
  return calculateKarneySurfaceMetrics(origin, target).distanceMeters;
}

function normalizeBearingDegrees(value: number, valueName: string): number {
  assertFiniteNumber(value, valueName);
  return ((value % 360) + 360) % 360;
}

/**
 * GeographicLibのKarney法でWGS84楕円体上の距離と初期方位角を求める。
 *
 * 三脚―被写体メトリクス、検索、プレビューなどの共通逆測地線計算に使用する。
 */
export function calculateKarneyLineMetrics(
  tripod: GroundPoint,
  subject: GroundPoint
): LineMetrics {
  assertFiniteNumber(tripod.height, "Karney line metrics tripod height");
  assertFiniteNumber(subject.height, "Karney line metrics subject height");

  const surfaceMetrics = calculateKarneySurfaceMetrics(tripod, subject);

  return {
    ...surfaceMetrics,
    heightDifferenceMeters: subject.height - tripod.height,
  };
}

/**
 * GeographicLibのKarney法で、始点・初期方位角・地表距離から終点を求める。
 * 戻り値の高度は呼び出し側でDEM標高に置き換える前提のため、始点高度を維持する。
 */
export function calculateKarneyDestinationPoint(
  origin: GroundPoint,
  bearingDegrees: number,
  distanceMeters: number
): GroundPoint {
  assertValidGeodeticCoordinate(origin, "Karney direct origin");

  assertFiniteNumber(origin.height, "Karney direct origin height");
  assertFiniteNumber(distanceMeters, "Karney direct distance");
  if (distanceMeters < 0) {
    throw new Error("Karney direct geodesic requires a non-negative distance.");
  }

  const result = Geodesic.WGS84.Direct(
    origin.latitude,
    origin.longitude,
    normalizeBearingDegrees(bearingDegrees, "Karney direct bearing"),
    distanceMeters,
    Geodesic.STANDARD
  );

  const destinationLatitude = result.lat2;
  const destinationLongitude = result.lon2;

  assertFiniteNumber(destinationLatitude, "Karney direct result latitude");
  assertFiniteNumber(destinationLongitude, "Karney direct result longitude");
  assertValidGeodeticCoordinate(
    { latitude: destinationLatitude, longitude: destinationLongitude },
    "Karney direct result"
  );

  return {
    latitude: destinationLatitude,
    longitude: destinationLongitude,
    height: origin.height,
    label: origin.label,
  };
}
