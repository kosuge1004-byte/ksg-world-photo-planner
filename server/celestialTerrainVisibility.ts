import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
} from "cesium";

import type {
  CelestialOcclusion,
  HorizontalCoordinates,
} from "../src/types/celestial.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";
import type { GroundPoint } from "../src/types/points.ts";
import { sampleServerLineOfSightTerrain } from "./worldTerrain.ts";
import { LruPromiseCache } from "./lruPromiseCache.ts";

const TERRAIN_DISTANCE_LIMIT_METERS = 160_000;
const TERRAIN_CLEARANCE_DEGREES = 0.015;
const horizonCache = new LruPromiseCache<TerrainHorizon>({
  maxEntries: 4_096,
  ttlMs: 6 * 60 * 60 * 1_000,
});

type TerrainHorizon = {
  maximumElevationDegrees: number;
  distanceMeters: number;
};

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("可視判定を中止しました", "AbortError");
}


function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  abortIfRequested(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("可視判定を中止しました", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

function destinationCartographic(
  origin: GroundPoint,
  azimuthDegrees: number,
  distanceMeters: number
): Cartographic {
  const destination = calculateKarneyDestinationPoint(
    origin,
    azimuthDegrees,
    distanceMeters
  );
  return Cartographic.fromDegrees(
    destination.longitude,
    destination.latitude,
    0
  );
}

function coarseDistances(): number[] {
  const minimum = 8;
  const samples = 112;
  return Array.from({ length: samples }, (_, index) =>
    minimum * (TERRAIN_DISTANCE_LIMIT_METERS / minimum) **
      (index / (samples - 1))
  );
}

function elevationAngleDegrees(
  origin: Cartesian3,
  localUp: Cartesian3,
  target: Cartesian3
): number {
  const direction = Cartesian3.subtract(target, origin, new Cartesian3());
  if (Cartesian3.magnitudeSquared(direction) < 1e-6) return -90;
  Cartesian3.normalize(direction, direction);
  return Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp)))) *
    180 / Math.PI;
}

function profileMaximum(
  origin: Cartesian3,
  distances: number[],
  samples: Cartographic[]
): TerrainHorizon & { index: number } {
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cartesian3());
  let maximumElevationDegrees = -90;
  let maximumIndex = 0;
  samples.forEach((sample, index) => {
    const elevation = elevationAngleDegrees(
      origin,
      localUp,
      Cartesian3.fromRadians(sample.longitude, sample.latitude, sample.height)
    );
    if (elevation > maximumElevationDegrees) {
      maximumElevationDegrees = elevation;
      maximumIndex = index;
    }
  });
  return {
    maximumElevationDegrees,
    distanceMeters: distances[maximumIndex],
    index: maximumIndex,
  };
}

async function calculateHorizon(
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  azimuthDegrees: number,
  signal?: AbortSignal
): Promise<TerrainHorizon> {
  abortIfRequested(signal);
  const origin = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + lensCenterHeightMeters
  );
  const distances = coarseDistances();
  const coarse = await sampleServerLineOfSightTerrain(
    distances.map((distance) => destinationCartographic(tripod, azimuthDegrees, distance)),
    distances,
    signal
  );
  const coarseMaximum = profileMaximum(origin, distances, coarse);
  const start = distances[Math.max(0, coarseMaximum.index - 2)];
  const end = distances[Math.min(distances.length - 1, coarseMaximum.index + 2)];
  const refinedDistances = Array.from({ length: 48 }, (_, index) =>
    start + (end - start) * index / 47
  );
  const refined = await sampleServerLineOfSightTerrain(
    refinedDistances.map((distance) =>
      destinationCartographic(tripod, azimuthDegrees, distance)
    ),
    refinedDistances,
    signal
  );
  abortIfRequested(signal);
  const refinedMaximum = profileMaximum(origin, refinedDistances, refined);
  return refinedMaximum.maximumElevationDegrees > coarseMaximum.maximumElevationDegrees
    ? refinedMaximum
    : coarseMaximum;
}

function cacheKey(
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  azimuthDegrees: number
): string {
  return [
    tripod.latitude.toFixed(6),
    tripod.longitude.toFixed(6),
    tripod.height.toFixed(1),
    lensCenterHeightMeters.toFixed(2),
    (Math.round((((azimuthDegrees % 360) + 360) % 360) / 0.02) * 0.02).toFixed(2),
  ].join(":");
}

export function createServerLineOfSightEvaluator(
  lensCenterHeightMeters: number
): (
  tripod: GroundPoint,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal
) => Promise<CelestialOcclusion> {
  return async (tripod, horizontal, signal) => {
    if (horizontal.altitudeDegrees <= 0) {
      return {
        visible: false,
        verified: true,
        terrainObstructed: true,
        photorealisticMeshObstructed: false,
        reason: "below-horizon",
        obstructionElevationDegrees: 0,
        obstructionDistanceMeters: 0,
      };
    }
    const key = cacheKey(tripod, lensCenterHeightMeters, horizontal.azimuthDegrees);
    const pending = horizonCache.getOrCreate(key, () =>
      calculateHorizon(
        tripod,
        lensCenterHeightMeters,
        horizontal.azimuthDegrees
      )
    );
    const horizon = await awaitWithAbort(pending, signal);
    const terrainObstructed =
      horizon.maximumElevationDegrees >=
      horizontal.altitudeDegrees - TERRAIN_CLEARANCE_DEGREES;
    return {
      visible: !terrainObstructed,
      verified: true,
      terrainObstructed,
      photorealisticMeshObstructed: false,
      reason: terrainObstructed ? "terrain" : "visible",
      obstructionElevationDegrees: horizon.maximumElevationDegrees,
      obstructionDistanceMeters: terrainObstructed
        ? horizon.distanceMeters
        : undefined,
    };
  };
}
