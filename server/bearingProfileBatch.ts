import {
  ABSOLUTE_MAX_DISTANCE_METERS,
  ABSOLUTE_MIN_DISTANCE_METERS,
  ADAPTIVE_COARSE_MAX_SPAN_METERS,
  densifyDistanceIntervals,
  logarithmicDistances,
} from "../src/cesium/tripodCandidates.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";
import type {
  BearingProfileBatchRequest,
  BearingProfileBatchCompactProfile,
  BearingProfileBatchResponseV2,
} from "../src/types/bearingProfileBatch.ts";
import {
  createTileCacheCounter,
  lookupGsiElevations,
  type GsiElevationRequestPoint,
  type GsiElevationSample,
  type TileCacheCounter,
} from "./gsiElevation.ts";
import { lookupGsiGeoidHeight } from "./gsiGeoid.ts";
import { lookupLocalJpgeo2024Height } from "./jpgeo2024Local.ts";

const MAX_BEARINGS_PER_REQUEST = 360;
const MAX_ELEVATION_POINTS_PER_LOOKUP = 2_048;
const MAX_GEOID_POINTS_PER_LOOKUP = 2_048;
// Keep only a small set of coordinates/elevation samples live at once. The
// response supports 360 x 640 points, but retaining repeated coordinate objects
// for all of them exceeds the Workers 128 MiB isolate limit.
const MAX_BEARINGS_PER_PROCESS_CHUNK = 8;

type Coordinate = { latitude: number; longitude: number };

export type BearingProfileBatchDependencies = {
  lookupElevations: (
    points: GsiElevationRequestPoint[],
    signal?: AbortSignal,
    counter?: TileCacheCounter
  ) => Promise<GsiElevationSample[]>;
  lookupGeoidHeights: (
    points: Coordinate[],
    signal?: AbortSignal
  ) => Promise<number[]>;
  nowIso: () => string;
};

export async function lookupBearingProfileGeoidHeights(
  points: Coordinate[],
  signal?: AbortSignal
): Promise<number[]> {
  const heights = new Array<number>(points.length);
  const uncovered: Array<{ index: number; point: Coordinate }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const local = lookupLocalJpgeo2024Height(point.latitude, point.longitude);
    if (local === null) uncovered.push({ index, point });
    else heights[index] = local;
  }
  if (uncovered.length > 0) {
    const fallback = await Promise.all(uncovered.map(({ point }) =>
      lookupGsiGeoidHeight(point.latitude, point.longitude, signal, true)
    ));
    uncovered.forEach(({ index }, fallbackIndex) => {
      heights[index] = fallback[fallbackIndex];
    });
  }
  return heights;
}

const defaultDependencies: BearingProfileBatchDependencies = {
  lookupElevations: lookupGsiElevations,
  // Every profile point uses its own JPGEO2024 bilinear value. Reusing one
  // regional representative can shift N by decimetres over a 50 km profile,
  // which would move the terrain intersection even though the DEM itself is
  // unchanged. Only points outside the bundled model retain the legacy CGI,
  // and that fallback also uses the original coordinate (pointSpecific=true).
  lookupGeoidHeights: lookupBearingProfileGeoidHeights,
  nowIso: () => new Date().toISOString(),
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBearingProfileBatchRequest(
  value: unknown
): value is BearingProfileBatchRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  const subject = request.subjectPoint;
  const camera = request.cameraSettings;
  if (typeof subject !== "object" || subject === null ||
    typeof camera !== "object" || camera === null) return false;
  const point = subject as Record<string, unknown>;
  const settings = camera as Record<string, unknown>;
  if (!finiteNumber(point.latitude) || point.latitude < 20 || point.latitude > 46.5 ||
    !finiteNumber(point.longitude) || point.longitude < 122 || point.longitude > 154 ||
    !finiteNumber(point.height) ||
    !finiteNumber(settings.lensCenterHeightMeters) || settings.lensCenterHeightMeters < 0 ||
    !finiteNumber(request.maxDistanceMeters) ||
    request.maxDistanceMeters < ABSOLUTE_MIN_DISTANCE_METERS ||
    request.maxDistanceMeters > ABSOLUTE_MAX_DISTANCE_METERS ||
    !Array.isArray(request.bearings) || request.bearings.length === 0 ||
    request.bearings.length > MAX_BEARINGS_PER_REQUEST) return false;
  const seen = new Set<number>();
  return request.bearings.every((bearing) => {
    if (!finiteNumber(bearing) || bearing < 0 || bearing >= 360 || seen.has(bearing)) return false;
    seen.add(bearing);
    return true;
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size)
  );
}

export async function computeBearingProfileBatch(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal,
  dependencies: BearingProfileBatchDependencies = defaultDependencies,
  tileCacheCounter: TileCacheCounter = createTileCacheCounter()
): Promise<BearingProfileBatchResponseV2> {
  if (!isBearingProfileBatchRequest(request)) {
    throw new Error("全方位地形の取得条件が不正です");
  }
  if (signal?.aborted) throw signal.reason;

  const distances = densifyDistanceIntervals(
    logarithmicDistances({
      minMeters: ABSOLUTE_MIN_DISTANCE_METERS,
      maxMeters: request.maxDistanceMeters,
    }, 32),
    ADAPTIVE_COARSE_MAX_SPAN_METERS
  );
  const profiles: BearingProfileBatchCompactProfile[] = [];
  const failedBearings: BearingProfileBatchResponseV2["failedBearings"] = [];
  for (
    let bearingStart = 0;
    bearingStart < request.bearings.length;
    bearingStart += MAX_BEARINGS_PER_PROCESS_CHUNK
  ) {
    if (signal?.aborted) throw signal.reason;
    const bearingChunk = request.bearings.slice(
      bearingStart,
      bearingStart + MAX_BEARINGS_PER_PROCESS_CHUNK
    );
    const prepared = bearingChunk.flatMap((bearingDegrees) =>
      distances.map((distanceMeters) => ({
        bearingDegrees,
        distanceMeters,
        destination: calculateKarneyDestinationPoint(
          request.subjectPoint,
          bearingDegrees,
          distanceMeters
        ),
      }))
    );
    const elevationRequests: GsiElevationRequestPoint[] = prepared.map(({ destination }) => ({
      latitude: destination.latitude,
      longitude: destination.longitude,
      maximumDetail: "1m",
      interpolationMode: "neutral",
    }));
    const elevationSamples: GsiElevationSample[] = [];
    for (const chunk of chunks(elevationRequests, MAX_ELEVATION_POINTS_PER_LOOKUP)) {
      if (signal?.aborted) throw signal.reason;
      elevationSamples.push(...await dependencies.lookupElevations(chunk, signal, tileCacheCounter));
    }
    if (elevationSamples.length !== prepared.length) {
      throw new Error("全方位地形APIの標高応答点数が一致しません");
    }

    const geoidValues: number[] = [];
    for (const chunk of chunks(
      prepared.map(({ destination }) => destination),
      MAX_GEOID_POINTS_PER_LOOKUP
    )) {
      if (signal?.aborted) throw signal.reason;
      geoidValues.push(...await dependencies.lookupGeoidHeights(chunk, signal));
    }
    if (geoidValues.length !== prepared.length) {
      throw new Error("全方位地形APIのジオイド応答点数が一致しません");
    }

    for (let localBearingIndex = 0; localBearingIndex < bearingChunk.length; localBearingIndex += 1) {
      const bearingDegrees = bearingChunk[localBearingIndex];
      const start = localBearingIndex * distances.length;
      const ellipsoidalHeightsMeters: number[] = [];
      const elevationSources: BearingProfileBatchCompactProfile["elevationSources"] = [];
      let failureReason: string | null = null;
      for (let distanceIndex = 0; distanceIndex < distances.length; distanceIndex += 1) {
        const index = start + distanceIndex;
        const sample = elevationSamples[index];
        const geoidHeightMeters = geoidValues[index];
        if (!Number.isFinite(geoidHeightMeters)) {
          failureReason = "ジオイド高を取得できない地点があります";
          break;
        }
        // A successful GSI lookup with no DEM source is the same authoritative
        // no-data/water case handled by worldTerrain.ts: orthometric H=0, so h=N.
        let orthometricHeightMeters: number;
        if (sample?.source !== null) {
          if (!sample?.source || !Number.isFinite(sample.heightMeters)) {
            failureReason = "DEM標高の応答が不正な地点があります";
            break;
          }
          orthometricHeightMeters = Number(sample.heightMeters);
        } else if (sample.heightMeters === null) {
          orthometricHeightMeters = 0;
        } else {
          failureReason = "DEM標高の応答が不正な地点があります";
          break;
        }
        ellipsoidalHeightsMeters.push(
          orthometricHeightMeters + (geoidHeightMeters as number)
        );
        elevationSources.push(sample.source);
      }
      if (failureReason) {
        failedBearings.push({ bearingDegrees, reason: failureReason });
        continue;
      }
      profiles.push({
        bearingDegrees,
        ellipsoidalHeightsMeters,
        elevationSources,
        computedAtIso: dependencies.nowIso(),
      });
    }
  }

  return {
    version: 2,
    distancesMeters: distances,
    profiles,
    failedBearings,
    requestedBearingCount: request.bearings.length,
    pointCount: request.bearings.length * distances.length,
  };
}
