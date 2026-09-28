import type { CameraSettings } from "./camera";
import type { GsiElevationApiSample } from "./geospatial";
import type { GroundPoint } from "./points";

export type BearingProfileBatchRequest = {
  subjectPoint: GroundPoint;
  cameraSettings: Pick<CameraSettings, "lensCenterHeightMeters">;
  bearings: number[];
  maxDistanceMeters: number;
};

export type BearingProfileBatchFailure = {
  bearingDegrees: number;
  reason: string;
};

export type BearingProfileBatchPoint = {
  distanceMeters: number;
  longitude: number;
  latitude: number;
  ellipsoidalHeightMeters: number;
  /**
   * The exact DEM tier used for this point. The browser needs this metadata to
   * persist the same decoded tiles as the established per-bearing path; it is
   * not used to recompute or alter the returned height.
   */
  elevationSource: GsiElevationApiSample["source"];
};

export type BearingProfileBatchProfile = {
  bearingDegrees: number;
  points: BearingProfileBatchPoint[];
  computedAtIso: string;
};

/** Legacy/normalized response retained for clients during a rolling deploy. */
export type BearingProfileBatchResponseV1 = {
  version: 1;
  /** The authoritative values came from an offline-generated registered-spot file. */
  precomputed?: boolean;
  profiles: BearingProfileBatchProfile[];
  failedBearings: BearingProfileBatchFailure[];
  requestedBearingCount: number;
  pointCount: number;
};

export type BearingProfileBatchCompactProfile = {
  bearingDegrees: number;
  /** One value for each entry in the response-level distancesMeters array. */
  ellipsoidalHeightsMeters: number[];
  elevationSources: GsiElevationApiSample["source"][];
  computedAtIso: string;
};

/**
 * Compact wire response. Coordinates are deliberately not repeated for every
 * point: the browser reconstructs them with the same Karney direct solver and
 * still applies its strict coordinate/distance validation before accepting a
 * profile. This keeps the 360-bearing contract within the Worker memory limit.
 */
export type BearingProfileBatchResponseV2 = {
  version: 2;
  /** The authoritative values came from an offline-generated registered-spot file. */
  precomputed?: boolean;
  distancesMeters: number[];
  profiles: BearingProfileBatchCompactProfile[];
  failedBearings: BearingProfileBatchFailure[];
  requestedBearingCount: number;
  pointCount: number;
};

export type BearingProfileBatchResponse =
  | BearingProfileBatchResponseV1
  | BearingProfileBatchResponseV2;
