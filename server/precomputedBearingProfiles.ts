import type {
  BearingProfileBatchRequest,
  BearingProfileBatchResponseV2,
} from "../src/types/bearingProfileBatch.ts";

export const PRECOMPUTED_BEARING_PROFILE_FORMAT =
  "astrosight-precomputed-bearing-profile-v1";
export const PRECOMPUTED_BEARING_PROFILE_DIRECTORY =
  "precomputed-bearing-profile-v1";

export type PrecomputedBearingProfileFile = {
  schemaVersion: 1;
  format: typeof PRECOMPUTED_BEARING_PROFILE_FORMAT;
  subject: {
    name: string;
    latitude: number;
    longitude: number;
  };
  maxDistanceMeters: number;
  generatedAt: string;
  response: BearingProfileBatchResponseV2;
};

export type PrecomputedBearingProfileManifestEntry = {
  name: string;
  latitude: number;
  longitude: number;
  maxDistanceMeters: number;
  file: string;
  bytes: number;
  sha256: string;
  profileCount: number;
  pointCount: number;
};

export type PrecomputedBearingProfileManifest = {
  schemaVersion: 1;
  format: typeof PRECOMPUTED_BEARING_PROFILE_FORMAT;
  generatedAt: string;
  entries: Record<string, PrecomputedBearingProfileManifestEntry>;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coordinates in the built-in catalogue are stable app data. Seven decimal
 * places preserves sub-centimetre identity while avoiding JSON formatting
 * differences between the generator, Pages and the local origin.
 */
export function precomputedBearingProfileIdentity(input: {
  latitude: number;
  longitude: number;
  maxDistanceMeters: number;
}): string {
  return [
    input.latitude.toFixed(7),
    input.longitude.toFixed(7),
    Math.round(input.maxDistanceMeters).toString(),
  ].join(":");
}

export function isPrecomputedBearingProfileResponse(
  value: unknown,
  request: Pick<BearingProfileBatchRequest, "bearings" | "maxDistanceMeters">
): value is BearingProfileBatchResponseV2 {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<BearingProfileBatchResponseV2>;
  if (
    response.version !== 2 ||
    !Array.isArray(response.distancesMeters) ||
    response.distancesMeters.length === 0 ||
    !Array.isArray(response.profiles) ||
    !Array.isArray(response.failedBearings) ||
    response.failedBearings.length !== 0 ||
    response.requestedBearingCount !== request.bearings.length ||
    !Number.isSafeInteger(response.pointCount) ||
    response.pointCount !== request.bearings.length * response.distancesMeters.length
  ) return false;
  const lastDistance = response.distancesMeters[response.distancesMeters.length - 1];
  if (!finite(lastDistance) || Math.abs(lastDistance - request.maxDistanceMeters) > 0.01) {
    return false;
  }
  if (response.distancesMeters.some((distance, index) =>
    !finite(distance) || distance < 0 ||
    (index > 0 && distance <= response.distancesMeters![index - 1])
  )) return false;

  const requested = new Set(request.bearings);
  const seen = new Set<number>();
  for (const profile of response.profiles) {
    if (
      typeof profile !== "object" || profile === null ||
      !finite(profile.bearingDegrees) ||
      !requested.has(profile.bearingDegrees) ||
      seen.has(profile.bearingDegrees) ||
      typeof profile.computedAtIso !== "string" ||
      !Array.isArray(profile.ellipsoidalHeightsMeters) ||
      !Array.isArray(profile.elevationSources) ||
      profile.ellipsoidalHeightsMeters.length !== response.distancesMeters.length ||
      profile.elevationSources.length !== response.distancesMeters.length ||
      profile.ellipsoidalHeightsMeters.some((height) => !finite(height)) ||
      profile.elevationSources.some((source) =>
        source !== null && source !== "DEM1A" && source !== "DEM5A" &&
        source !== "DEM5B" && source !== "DEM5C" && source !== "DEM10B"
      )
    ) return false;
    seen.add(profile.bearingDegrees);
  }
  return seen.size === requested.size;
}

export function selectPrecomputedBearingProfiles(
  stored: BearingProfileBatchResponseV2,
  bearings: readonly number[]
): BearingProfileBatchResponseV2 | null {
  const byBearing = new Map(
    stored.profiles.map((profile) => [profile.bearingDegrees, profile] as const)
  );
  const profiles = bearings.map((bearing) => byBearing.get(bearing));
  if (profiles.some((profile) => !profile)) return null;
  return {
    version: 2,
    precomputed: true,
    distancesMeters: stored.distancesMeters,
    profiles: profiles as BearingProfileBatchResponseV2["profiles"],
    failedBearings: [],
    requestedBearingCount: bearings.length,
    pointCount: bearings.length * stored.distancesMeters.length,
  };
}
