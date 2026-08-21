export type HeightSource = "dem" | "terrain" | "3d-picked" | "manual" | "legacy";

export type GroundPoint = {
  latitude: number;
  longitude: number;
  /** @deprecated Compatibility field. New precision code must use the explicit height helpers below. */
  height: number;
  /** WGS84 ellipsoid height used by Cesium/ECEF. */
  ellipsoidalHeightMeters?: number;
  /** Orthometric (mean sea level) height used by Astronomy Engine. */
  orthometricHeightMeters?: number;
  /** Geoid separation N = h_ellipsoid - H_orthometric. */
  geoidHeightMeters?: number;
  heightSource?: HeightSource;
  label: string;
};


export type ResolvedGroundPoint = GroundPoint & {
  ellipsoidalHeightMeters: number;
  orthometricHeightMeters: number;
  geoidHeightMeters: number;
  heightSource: Exclude<HeightSource, "legacy">;
};

export function isResolvedGroundPoint(point: GroundPoint): point is ResolvedGroundPoint {
  return Number.isFinite(point.ellipsoidalHeightMeters) &&
    Number.isFinite(point.orthometricHeightMeters) &&
    Number.isFinite(point.geoidHeightMeters) &&
    point.heightSource !== undefined &&
    point.heightSource !== "legacy";
}

export function ellipsoidalHeightMeters(point: GroundPoint): number {
  const value = point.ellipsoidalHeightMeters ?? point.height;
  if (!Number.isFinite(value)) throw new Error(`${point.label || "地点"}の楕円体高が不正です`);
  return value;
}

export function orthometricHeightMeters(point: GroundPoint): number {
  const explicit = point.orthometricHeightMeters;
  if (Number.isFinite(explicit)) return explicit as number;
  const geoid = point.geoidHeightMeters;
  if (Number.isFinite(geoid)) return ellipsoidalHeightMeters(point) - (geoid as number);
  // Legacy/project-loaded points may not yet contain split heights. Keeping this fallback
  // preserves compatibility, while all newly resolved points are populated explicitly.
  return ellipsoidalHeightMeters(point);
}

export function withLensCenterHeight(point: GroundPoint, lensCenterHeightMeters: number, label?: string): GroundPoint {
  const ellipsoidal = ellipsoidalHeightMeters(point) + lensCenterHeightMeters;
  const orthometric = orthometricHeightMeters(point) + lensCenterHeightMeters;
  return {
    ...point,
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: orthometric,
    label: label ?? `${point.label}レンズ中心`,
  };
}

/**
 * Applies a user-requested vertical offset to a resolved point.
 * This is intentionally separate from lens-center height so placement offsets
 * cannot be confused with camera geometry.
 */
export function withVerticalOffset(
  point: GroundPoint,
  offsetMeters: number,
  label?: string
): GroundPoint {
  if (!Number.isFinite(offsetMeters)) {
    throw new Error("上空オフセットが不正です");
  }
  const ellipsoidal = ellipsoidalHeightMeters(point) + offsetMeters;
  const orthometric = orthometricHeightMeters(point) + offsetMeters;
  return {
    ...point,
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: orthometric,
    heightSource: "manual",
    label: label ?? point.label,
  };
}

export type LineMetrics = {
  distanceMeters: number;
  bearingDegrees: number;
  heightDifferenceMeters: number;
};
