import { Cartographic, Math as CesiumMath } from "cesium";

import type { TerrainSampler } from "../src/cesium/tripodCandidates.ts";
import { calculateKarneyLineMetrics } from "../src/geodesy/karneyGeodesic.ts";
import type { GroundPoint } from "../src/types/points.ts";
import type { BearingProfileBatchResponseV2 } from "../src/types/bearingProfileBatch.ts";

type CompactProfile = BearingProfileBatchResponseV2["profiles"][number];

function normalizedBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

function snappedBearing(value: number): number {
  const normalized = normalizedBearing(value);
  const rounded = Math.round(normalized) % 360;
  const difference = Math.min(
    Math.abs(normalized - rounded),
    360 - Math.abs(normalized - rounded)
  );
  // Karney inverse(direct(...)) can return 359.999999999... for an exact
  // 0-degree profile node. Snap only floating-point noise, never a real angle.
  return difference <= 1e-8 ? rounded : normalized;
}

function distanceBracket(distances: readonly number[], distance: number): {
  low: number;
  high: number;
  fraction: number;
} | null {
  const nodeToleranceMeters = 0.00001;
  if (
    distances.length === 0 ||
    distance < distances[0] - nodeToleranceMeters ||
    distance > distances[distances.length - 1] + nodeToleranceMeters
  ) return null;
  if (Math.abs(distance - distances[0]) <= nodeToleranceMeters) {
    return { low: 0, high: 0, fraction: 0 };
  }
  const lastIndex = distances.length - 1;
  if (Math.abs(distance - distances[lastIndex]) <= nodeToleranceMeters) {
    return { low: lastIndex, high: lastIndex, fraction: 0 };
  }
  let low = 0;
  let high = distances.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (distances[middle] <= distance) low = middle;
    else high = middle;
  }
  if (Math.abs(distances[low] - distance) <= nodeToleranceMeters || low === high) {
    return { low, high: low, fraction: 0 };
  }
  if (Math.abs(distances[high] - distance) <= nodeToleranceMeters) {
    return { low: high, high, fraction: 0 };
  }
  const span = distances[high] - distances[low];
  if (!(span > 0)) return null;
  return { low, high, fraction: (distance - distances[low]) / span };
}

function interpolateDistance(
  profile: CompactProfile,
  bracket: NonNullable<ReturnType<typeof distanceBracket>>
): number | null {
  const low = profile.ellipsoidalHeightsMeters[bracket.low];
  const high = profile.ellipsoidalHeightsMeters[bracket.high];
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return low + (high - low) * bracket.fraction;
}

/**
 * Use the offline 360-bearing profile only for the 10 m coarse/bracketing pass.
 * Every 1 m refinement and final candidate verification is deliberately sent
 * to the established exact sampler, so cached profile values never become a
 * final tripod coordinate or height.
 */
export function createPrecomputedSpotSearchTerrainSampler(
  subject: GroundPoint,
  response: BearingProfileBatchResponseV2,
  exactSampler: TerrainSampler
): TerrainSampler {
  const profiles = new Map<number, CompactProfile>();
  for (const profile of response.profiles) {
    profiles.set(normalizedBearing(profile.bearingDegrees), profile);
  }

  return async (points, signal, maximumDetail) => {
    if (maximumDetail !== "10m" || signal?.aborted) {
      return exactSampler(points, signal, maximumDetail);
    }

    const output = new Array<Cartographic>(points.length);
    const fallbackIndexes: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      try {
        const target: GroundPoint = {
          latitude: CesiumMath.toDegrees(point.latitude),
          longitude: CesiumMath.toDegrees(point.longitude),
          height: Number.isFinite(point.height) ? point.height : 0,
          label: "計算済み地形照合点",
        };
        const metrics = calculateKarneyLineMetrics(subject, target);
        const bracket = distanceBracket(response.distancesMeters, metrics.distanceMeters);
        if (!bracket) {
          fallbackIndexes.push(index);
          continue;
        }
        const bearing = snappedBearing(metrics.bearingDegrees);
        const lowBearing = Math.floor(bearing);
        const highBearing = (lowBearing + 1) % 360;
        const lowProfile = profiles.get(lowBearing);
        const highProfile = profiles.get(highBearing);
        if (!lowProfile || !highProfile) {
          fallbackIndexes.push(index);
          continue;
        }
        const lowHeight = interpolateDistance(lowProfile, bracket);
        const highHeight = interpolateDistance(highProfile, bracket);
        if (lowHeight === null || highHeight === null) {
          fallbackIndexes.push(index);
          continue;
        }
        const bearingFraction = bearing - lowBearing;
        output[index] = Cartographic.clone(point);
        output[index].height = lowHeight + (highHeight - lowHeight) * bearingFraction;
      } catch {
        fallbackIndexes.push(index);
      }
    }

    if (fallbackIndexes.length > 0) {
      const fallback = await exactSampler(
        fallbackIndexes.map((index) => points[index]),
        signal,
        maximumDetail
      );
      fallbackIndexes.forEach((outputIndex, fallbackIndex) => {
        output[outputIndex] = fallback[fallbackIndex];
      });
    }
    return output;
  };
}
