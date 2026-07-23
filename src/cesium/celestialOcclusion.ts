import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Matrix4,
  Ray,
  SceneMode,
  Transforms,
} from "cesium";
import type {
  Scene,
  Viewer,
} from "cesium";

import type {
  CelestialOcclusion,
  HorizontalCoordinates,
} from "../types/celestial";
import type { TerrainDataSource } from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import {
  groundPointFromCoordinates,
  sampleTerrainLineOfSightProfile,
  terrainDataSource,
} from "./worldTerrain";

type SceneRayIntersection = {
  object?: unknown;
  position?: Cartesian3;
};

type RayPickingScene = Scene & {
  drillPickFromRayMostDetailed?: (
    ray: Ray,
    limit?: number,
    objectsToExclude?: unknown[],
    width?: number
  ) => Promise<SceneRayIntersection[]>;
};

type TerrainHorizon = {
  maximumElevationDegrees: number;
  distanceMeters: number;
  dataSource: TerrainDataSource;
};

export type CelestialLineOfSightObserver = {
  tripod: GroundPoint;
  lensCenterHeightMeters: number;
  terrainOrigin: Cartesian3;
  meshOrigin: Cartesian3;
};

const EARTH_RADIUS_METERS = 6_371_008.8;
const TERRAIN_DISTANCE_LIMIT_METERS = 160_000;
const TERRAIN_AZIMUTH_CACHE_STEP_DEGREES = 0.02;
const MAX_TERRAIN_CACHE_ENTRIES = 384;
const terrainHorizonCache = new Map<string, Promise<TerrainHorizon>>();

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("可視判定を中止しました", "AbortError");
  }
}

function destinationCartographic(
  origin: GroundPoint,
  azimuthDegrees: number,
  distanceMeters: number
): Cartographic {
  const bearing = azimuthDegrees * Math.PI / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const latitude = origin.latitude * Math.PI / 180;
  const longitude = origin.longitude * Math.PI / 180;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const destinationLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude)
  );
  return new Cartographic(destinationLongitude, destinationLatitude, 0);
}

function coarseProfileDistances(): number[] {
  const minimum = 8;
  const maximum = TERRAIN_DISTANCE_LIMIT_METERS;
  const samples = 112;
  return Array.from({ length: samples }, (_, index) => {
    const ratio = index / (samples - 1);
    return minimum * (maximum / minimum) ** ratio;
  });
}

function elevationAngleDegrees(
  origin: Cartesian3,
  localUp: Cartesian3,
  target: Cartesian3
): number {
  const direction = Cartesian3.subtract(target, origin, new Cartesian3());
  if (Cartesian3.magnitudeSquared(direction) < 1e-6) return -90;
  Cartesian3.normalize(direction, direction);
  return Math.asin(
    Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp)))
  ) * 180 / Math.PI;
}

function profileMaximum(
  observer: CelestialLineOfSightObserver,
  distances: number[],
  samples: Cartographic[]
): TerrainHorizon & { index: number } {
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
    observer.terrainOrigin,
    new Cartesian3()
  );
  let maximumElevationDegrees = -90;
  let maximumIndex = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const target = Cartesian3.fromRadians(
      sample.longitude,
      sample.latitude,
      Number.isFinite(sample.height) ? sample.height : 0
    );
    const elevation = elevationAngleDegrees(observer.terrainOrigin, localUp, target);
    if (elevation > maximumElevationDegrees) {
      maximumElevationDegrees = elevation;
      maximumIndex = index;
    }
  }
  return {
    maximumElevationDegrees,
    distanceMeters: distances[maximumIndex],
    dataSource: terrainDataSource(samples[maximumIndex]),
    index: maximumIndex,
  };
}

function refinementDistances(
  distances: number[],
  maximumIndex: number
): number[] {
  const start = distances[Math.max(0, maximumIndex - 2)];
  const end = distances[Math.min(distances.length - 1, maximumIndex + 2)];
  const stepCount = 48;
  return Array.from({ length: stepCount }, (_, index) =>
    start + (end - start) * index / (stepCount - 1)
  );
}

async function calculateTerrainHorizon(
  observer: CelestialLineOfSightObserver,
  azimuthDegrees: number,
  signal?: AbortSignal
): Promise<TerrainHorizon> {
  abortIfRequested(signal);
  const coarseDistances = coarseProfileDistances();
  const coarseCoordinates = coarseDistances.map((distance) =>
    destinationCartographic(observer.tripod, azimuthDegrees, distance)
  );
  const coarseSamples = await sampleTerrainLineOfSightProfile(
    coarseCoordinates,
    coarseDistances
  );
  abortIfRequested(signal);
  const coarseMaximum = profileMaximum(observer, coarseDistances, coarseSamples);
  const refinedDistances = refinementDistances(coarseDistances, coarseMaximum.index);
  const refinedCoordinates = refinedDistances.map((distance) =>
    destinationCartographic(observer.tripod, azimuthDegrees, distance)
  );
  const refinedSamples = await sampleTerrainLineOfSightProfile(
    refinedCoordinates,
    refinedDistances
  );
  abortIfRequested(signal);
  const refinedMaximum = profileMaximum(observer, refinedDistances, refinedSamples);
  return refinedMaximum.maximumElevationDegrees > coarseMaximum.maximumElevationDegrees
    ? refinedMaximum
    : coarseMaximum;
}

function terrainCacheKey(
  observer: CelestialLineOfSightObserver,
  azimuthDegrees: number
): string {
  const normalizedAzimuth = ((azimuthDegrees % 360) + 360) % 360;
  const bucket = Math.round(normalizedAzimuth / TERRAIN_AZIMUTH_CACHE_STEP_DEGREES);
  return [
    observer.tripod.latitude.toFixed(6),
    observer.tripod.longitude.toFixed(6),
    observer.terrainOrigin.x.toFixed(1),
    observer.terrainOrigin.y.toFixed(1),
    observer.terrainOrigin.z.toFixed(1),
    bucket,
  ].join(":");
}

function cachedTerrainHorizon(
  observer: CelestialLineOfSightObserver,
  azimuthDegrees: number,
  signal?: AbortSignal
): Promise<TerrainHorizon> {
  const key = terrainCacheKey(observer, azimuthDegrees);
  const cached = terrainHorizonCache.get(key);
  if (cached) return cached;
  const calculation = calculateTerrainHorizon(observer, azimuthDegrees, signal)
    .catch((error) => {
      terrainHorizonCache.delete(key);
      throw error;
    });
  terrainHorizonCache.set(key, calculation);
  if (terrainHorizonCache.size > MAX_TERRAIN_CACHE_ENTRIES) {
    const oldestKey = terrainHorizonCache.keys().next().value;
    if (typeof oldestKey === "string") terrainHorizonCache.delete(oldestKey);
  }
  return calculation;
}

export function celestialWorldDirection(
  origin: Cartesian3,
  horizontal: HorizontalCoordinates
): Cartesian3 {
  const azimuth = horizontal.azimuthDegrees * Math.PI / 180;
  const altitude = horizontal.altitudeDegrees * Math.PI / 180;
  const cosAltitude = Math.cos(altitude);
  const localDirection = new Cartesian3(
    cosAltitude * Math.sin(azimuth),
    cosAltitude * Math.cos(azimuth),
    Math.sin(altitude)
  );
  const localFrame = Transforms.eastNorthUpToFixedFrame(origin);
  const worldDirection = Matrix4.multiplyByPointAsVector(
    localFrame,
    localDirection,
    new Cartesian3()
  );
  return Cartesian3.normalize(worldDirection, worldDirection);
}

async function photorealisticMeshIntersection(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal
): Promise<{ verified: boolean; distanceMeters: number | null }> {
  abortIfRequested(signal);
  const scene = viewer.scene as RayPickingScene;
  if (
    scene.mode !== SceneMode.SCENE3D ||
    typeof scene.drillPickFromRayMostDetailed !== "function"
  ) {
    return { verified: false, distanceMeters: null };
  }
  const ray = new Ray(
    observer.meshOrigin,
    celestialWorldDirection(observer.meshOrigin, horizontal)
  );
  const intersections = await scene.drillPickFromRayMostDetailed.call(
    scene,
    ray,
    24,
    [...viewer.entities.values],
    0.12
  );
  abortIfRequested(signal);
  const minimumDistance = Math.max(3, observer.lensCenterHeightMeters * 0.75);
  const obstruction = intersections.find((intersection) => {
    if (!intersection.position) return false;
    const distance = Cartesian3.distance(observer.meshOrigin, intersection.position);
    return distance > minimumDistance && distance < 500_000;
  });
  return {
    verified: true,
    distanceMeters: obstruction?.position
      ? Cartesian3.distance(observer.meshOrigin, obstruction.position)
      : null,
  };
}

export async function prepareCelestialLineOfSightObserver(
  viewer: Viewer,
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  signal?: AbortSignal
): Promise<CelestialLineOfSightObserver> {
  abortIfRequested(signal);
  const preciseGround = await groundPointFromCoordinates(
    tripod.latitude,
    tripod.longitude,
    "三脚位置の高精度地表"
  );
  abortIfRequested(signal);
  const terrainOrigin = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    preciseGround.height + lensCenterHeightMeters
  );
  const approximateSurface = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height
  );
  let meshSurface = approximateSurface;
  try {
    const clamped = (
      await viewer.scene.clampToHeightMostDetailed(
        [approximateSurface],
        [...viewer.entities.values],
        0.2
      )
    )[0];
    if (clamped) meshSurface = clamped;
  } catch (error) {
    console.warn("Google実景メッシュの三脚地表を取得できませんでした", error);
  }
  const meshUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
    meshSurface,
    new Cartesian3()
  );
  const meshOrigin = Cartesian3.add(
    meshSurface,
    Cartesian3.multiplyByScalar(meshUp, lensCenterHeightMeters, new Cartesian3()),
    new Cartesian3()
  );
  return {
    tripod: { ...tripod, height: preciseGround.height },
    lensCenterHeightMeters,
    terrainOrigin,
    meshOrigin,
  };
}

export async function evaluateCelestialLineOfSight(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal
): Promise<CelestialOcclusion> {
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
  const [terrain, mesh] = await Promise.all([
    cachedTerrainHorizon(observer, horizontal.azimuthDegrees, signal),
    photorealisticMeshIntersection(viewer, observer, horizontal, signal),
  ]);
  const terrainObstructed =
    terrain.maximumElevationDegrees >= horizontal.altitudeDegrees - 0.015;
  const photorealisticMeshObstructed = mesh.distanceMeters !== null;
  const verified = mesh.verified;
  const visible = verified && !terrainObstructed && !photorealisticMeshObstructed;
  return {
    visible,
    verified,
    terrainObstructed,
    photorealisticMeshObstructed,
    reason: !verified
      ? "unverified"
      : terrainObstructed
        ? "terrain"
        : photorealisticMeshObstructed
          ? "building-or-surface"
          : "visible",
    obstructionElevationDegrees: terrain.maximumElevationDegrees,
    obstructionDistanceMeters: terrainObstructed
      ? terrain.distanceMeters
      : mesh.distanceMeters ?? undefined,
    terrainDataSource: terrain.dataSource,
  };
}

/** サーバーでDEM可視判定済みの候補に、端末上のGoogle 3D表面判定だけを追加する。 */
export async function evaluatePhotorealisticMeshLineOfSight(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal
): Promise<CelestialOcclusion> {
  if (horizontal.altitudeDegrees <= 0) {
    return {
      visible: false,
      verified: true,
      terrainObstructed: false,
      photorealisticMeshObstructed: false,
      reason: "below-horizon",
    };
  }
  const mesh = await photorealisticMeshIntersection(
    viewer,
    observer,
    horizontal,
    signal
  );
  const photorealisticMeshObstructed = mesh.distanceMeters !== null;
  return {
    visible: mesh.verified && !photorealisticMeshObstructed,
    verified: mesh.verified,
    terrainObstructed: false,
    photorealisticMeshObstructed,
    reason: !mesh.verified
      ? "unverified"
      : photorealisticMeshObstructed
        ? "building-or-surface"
        : "visible",
    obstructionDistanceMeters: mesh.distanceMeters ?? undefined,
  };
}
