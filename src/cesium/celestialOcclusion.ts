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
import { publishUserNotice } from "../errors/userFeedback";
import {
  failedCelestialOcclusion,
} from "../types/celestial";
import type { BuildingOcclusionDetailSettings } from "../types/precision";
import type { TerrainDataSource } from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import { classifyTerrainOcclusion } from "../celestial/terrainOcclusionPolicy";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { terrestrialRefractionCorrectionDegrees } from "../geodesy/terrestrialRefraction";
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
  meshSurfaceVerified: boolean;
};

const TERRAIN_DISTANCE_LIMIT_METERS = 160_000;
const TERRAIN_AZIMUTH_CACHE_STEP_DEGREES = 0.02;
const MAX_TERRAIN_CACHE_ENTRIES = 384;
const terrainHorizonCache = new Map<string, Promise<TerrainHorizon>>();
const MAX_MESH_LINE_OF_SIGHT_CACHE_ENTRIES = 512;
type MeshIntersectionResult = { verified: boolean; distanceMeters: number | null };
type MeshIntersectionOutcome =
  | { ok: true; result: MeshIntersectionResult }
  | { ok: false; error: unknown };
const meshLineOfSightCache = new WeakMap<Viewer, Map<string, Promise<MeshIntersectionResult>>>();
const observerPreparationCache = new WeakMap<Viewer, Map<string, Promise<CelestialLineOfSightObserver>>>();

/** 条件変更後に古い地形・3Dレイ判定を再利用しないための一元化された無効化入口。 */
export function invalidateCelestialOcclusionCaches(viewer?: Viewer): void {
  terrainHorizonCache.clear();
  if (viewer) {
    meshLineOfSightCache.delete(viewer);
    observerPreparationCache.delete(viewer);
  }
}

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
    // 天体側の大気差補正との非対称性を避けるため、稜線までの距離に
    // 応じた地表屈折補正を加えた上で稜線最高点を探す。
    const elevation =
      elevationAngleDegrees(observer.terrainOrigin, localUp, target) +
      terrestrialRefractionCorrectionDegrees(distances[index]);
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

function boundedPromiseCacheSet<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  value: Promise<T>,
  maximumEntries: number,
): void {
  cache.set(key, value);
  if (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey === "string") cache.delete(oldestKey);
  }
}

function meshLineOfSightKey(
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  maximumDistanceMeters?: number,
): string {
  return [
    observer.meshOrigin.x,
    observer.meshOrigin.y,
    observer.meshOrigin.z,
    horizontal.azimuthDegrees,
    horizontal.altitudeDegrees,
    maximumDistanceMeters ?? "unbounded",
  ].join(":");
}

function observerPreparationKey(
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
): string {
  return [
    tripod.latitude,
    tripod.longitude,
    tripod.height,
    lensCenterHeightMeters,
  ].join(":");
}

async function calculatePhotorealisticMeshIntersection(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  maximumDistanceMeters?: number,
): Promise<MeshIntersectionResult> {
  const scene = viewer.scene as RayPickingScene;
  if (
    !observer.meshSurfaceVerified ||
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
  const minimumDistance = Math.max(3, observer.lensCenterHeightMeters * 0.75);
  const obstruction = intersections.find((intersection) => {
    if (!intersection.position) return false;
    const distance = Cartesian3.distance(observer.meshOrigin, intersection.position);
    const maximumDistance = maximumDistanceMeters ?? 500_000;
    return distance > minimumDistance && distance < maximumDistance;
  });
  return {
    verified: true,
    distanceMeters: obstruction?.position
      ? Cartesian3.distance(observer.meshOrigin, obstruction.position)
      : null,
  };
}

async function photorealisticMeshIntersection(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal,
  maximumDistanceMeters?: number,
): Promise<MeshIntersectionResult> {
  abortIfRequested(signal);
  let viewerCache = meshLineOfSightCache.get(viewer);
  if (!viewerCache) {
    viewerCache = new Map();
    meshLineOfSightCache.set(viewer, viewerCache);
  }
  const key = meshLineOfSightKey(observer, horizontal, maximumDistanceMeters);
  let calculation = viewerCache.get(key);
  if (!calculation) {
    calculation = calculatePhotorealisticMeshIntersection(
      viewer,
      observer,
      horizontal,
      maximumDistanceMeters
    )
      .catch((error) => {
        viewerCache?.delete(key);
        throw error;
      });
    boundedPromiseCacheSet(viewerCache, key, calculation, MAX_MESH_LINE_OF_SIGHT_CACHE_ENTRIES);
  }
  const result = await calculation;
  abortIfRequested(signal);
  return result;
}

async function calculateCelestialLineOfSightObserver(
  viewer: Viewer,
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
): Promise<CelestialLineOfSightObserver> {

  const preciseGround = await groundPointFromCoordinates(
    tripod.latitude,
    tripod.longitude,
    "三脚位置の高精度地表"
  );
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
  let meshSurfaceVerified = false;
  try {
    const clamped = (
      await viewer.scene.clampToHeightMostDetailed(
        [approximateSurface],
        [...viewer.entities.values],
        0.2
      )
    )[0];
    if (clamped) {
      meshSurface = clamped;
      meshSurfaceVerified = true;
    }
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
    meshSurfaceVerified,
  };
}

export async function prepareCelestialLineOfSightObserver(
  viewer: Viewer,
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  signal?: AbortSignal,
): Promise<CelestialLineOfSightObserver> {
  abortIfRequested(signal);
  let viewerCache = observerPreparationCache.get(viewer);
  if (!viewerCache) {
    viewerCache = new Map();
    observerPreparationCache.set(viewer, viewerCache);
  }
  const key = observerPreparationKey(tripod, lensCenterHeightMeters);
  let preparation = viewerCache.get(key);
  if (!preparation) {
    preparation = calculateCelestialLineOfSightObserver(
      viewer,
      tripod,
      lensCenterHeightMeters,
    ).catch((error) => {
      viewerCache?.delete(key);
      throw error;
    });
    boundedPromiseCacheSet(viewerCache, key, preparation, 256);
  }
  const observer = await preparation;
  abortIfRequested(signal);
  return observer;
}

export async function evaluateCelestialLineOfSight(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal,
  onDemVerified?: (result: CelestialOcclusion) => void,
): Promise<CelestialOcclusion> {
  if (horizontal.altitudeDegrees <= 0) {
    return {
      verificationState: "dem-and-google-3d",
      visible: false,
      verified: true,
      terrainObstructed: true,
      photorealisticMeshObstructed: false,
      reason: "below-horizon",
      obstructionElevationDegrees: 0,
      obstructionDistanceMeters: 0,
      celestialApparentAltitudeDegrees: horizontal.altitudeDegrees,
      celestialGeometricAltitudeDegrees:
        horizontal.geometricAltitudeDegrees ?? horizontal.altitudeDegrees,
    };
  }
  const meshPromise: Promise<MeshIntersectionOutcome> =
    photorealisticMeshIntersection(viewer, observer, horizontal, signal)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
  let terrain: TerrainHorizon;
  try {
    terrain = await cachedTerrainHorizon(
      observer,
      horizontal.azimuthDegrees,
      signal
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    publishUserNotice({
      key: "terrain-occlusion-failed",
      tone: "warning",
      message: "地形データを取得できないため、遮蔽物を確認できませんでした。天体は未確認として表示しています。",
    });
    return failedCelestialOcclusion(
      error instanceof Error ? error.message : "DEM遮蔽判定に失敗しました"
    );
  }
  const terrainDecision = classifyTerrainOcclusion(
    horizontal.altitudeDegrees,
    terrain.maximumElevationDegrees,
    undefined,
    terrain.distanceMeters
  );
  const terrainObstructed = terrainDecision.status === "obstructed";
  const terrainBoundaryUncertain = terrainDecision.status === "uncertain";
  const demOnlyResult: CelestialOcclusion = {
    verificationState: "dem-only",
    visible: !terrainObstructed,
    verified: false,
    terrainObstructed,
    photorealisticMeshObstructed: false,
    reason: terrainObstructed ? "terrain" : "unverified",
    obstructionElevationDegrees: terrain.maximumElevationDegrees,
    celestialApparentAltitudeDegrees: horizontal.altitudeDegrees,
    celestialGeometricAltitudeDegrees:
      horizontal.geometricAltitudeDegrees ?? horizontal.altitudeDegrees,
    terrainClearanceDegrees: terrainDecision.clearanceDegrees,
    terrainBoundaryUncertain,
    obstructionDistanceMeters: terrainObstructed
      ? terrain.distanceMeters
      : undefined,
    terrainDataSource: terrain.dataSource,
  };
  abortIfRequested(signal);
  onDemVerified?.(demOnlyResult);

  const meshOutcome = await meshPromise;
  abortIfRequested(signal);
  if (!meshOutcome.ok) {
    publishUserNotice({
      key: "google-3d-occlusion-fallback",
      tone: "warning",
      message: "Google 3Dによる遮蔽物確認が完了しなかったため、地形データのみの結果を表示しています。",
    });
    return {
      ...demOnlyResult,
      failureMessage: meshOutcome.error instanceof Error
        ? meshOutcome.error.message
        : "Google 3D遮蔽判定に失敗しました",
    };
  }
  const mesh = meshOutcome.result;
  if (!mesh.verified) {
    publishUserNotice({
      key: "google-3d-occlusion-fallback",
      tone: "warning",
      message: "Google 3Dによる遮蔽物確認が完了しなかったため、地形データのみの結果を表示しています。",
    });
    return {
      ...demOnlyResult,
      failureMessage: "Google 3D遮蔽判定を完了できませんでした",
    };
  }
  const photorealisticMeshObstructed = mesh.distanceMeters !== null;
  const visible = !terrainObstructed && !photorealisticMeshObstructed;
  return {
    verificationState: "dem-and-google-3d",
    visible,
    verified: !terrainBoundaryUncertain,
    terrainObstructed,
    photorealisticMeshObstructed,
    reason: terrainObstructed
      ? "terrain"
      : photorealisticMeshObstructed
        ? "building-or-surface"
        : terrainBoundaryUncertain
          ? "unverified"
          : "visible",
    obstructionElevationDegrees: terrain.maximumElevationDegrees,
    obstructionDistanceMeters: terrainObstructed
      ? terrain.distanceMeters
      : mesh.distanceMeters ?? undefined,
    terrainDataSource: terrain.dataSource,
    failureMessage: terrainBoundaryUncertain
      ? "天体高度と地形稜線が0.015度以内のため遮蔽を確定していません"
      : undefined,
  };
}

/** 天体の円盤を中心＋縁の複数点でサンプリングする方位・高度の配列を作る。 */
function buildDiscSamplePoints(
  center: HorizontalCoordinates,
  discDetail?: {
    angularDiameterDegrees: number;
    detailSettings: BuildingOcclusionDetailSettings;
  }
): HorizontalCoordinates[] {
  if (
    !discDetail ||
    !discDetail.detailSettings.detailedEdgeCheckEnabled ||
    discDetail.angularDiameterDegrees <= 0 ||
    discDetail.detailSettings.edgeSampleCount <= 0
  ) {
    return [center];
  }
  const radiusDegrees = discDetail.angularDiameterDegrees / 2;
  // 高緯度（高仰角）ほど方位1度あたりの実角距離が縮むため、方位方向のオフセットを
  // cos(仰角)で割って円盤が真円に見えるよう補正する。
  const cosAltitude = Math.max(
    0.05,
    Math.cos((center.altitudeDegrees * Math.PI) / 180)
  );
  const sampleCount = discDetail.detailSettings.edgeSampleCount;
  const points: HorizontalCoordinates[] = [center];
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = (2 * Math.PI * index) / sampleCount;
    points.push({
      azimuthDegrees:
        center.azimuthDegrees + (radiusDegrees * Math.sin(angle)) / cosAltitude,
      altitudeDegrees: center.altitudeDegrees + radiusDegrees * Math.cos(angle),
    });
  }
  return points;
}


/** 三脚レンズ中心から指定した被写体位置までの有限線分について、Google実景メッシュとの交差を確認する。
 * 天体用の地平線判定や視直径サンプリングは使用しない。
 */
export async function evaluatePhotorealisticMeshSegmentLineOfSight(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  target: Cartesian3,
  signal?: AbortSignal,
  maximumDistanceMeters?: number,
): Promise<CelestialOcclusion> {
  abortIfRequested(signal);
  const worldDirection = Cartesian3.subtract(
    target,
    observer.meshOrigin,
    new Cartesian3()
  );
  if (Cartesian3.magnitudeSquared(worldDirection) < 1e-6) {
    return {
      verificationState: "dem-and-google-3d",
      visible: true,
      verified: true,
      terrainObstructed: false,
      photorealisticMeshObstructed: false,
      reason: "visible",
    };
  }
  Cartesian3.normalize(worldDirection, worldDirection);

  const localFrame = Transforms.eastNorthUpToFixedFrame(observer.meshOrigin);
  const inverseLocalFrame = Matrix4.inverseTransformation(
    localFrame,
    new Matrix4()
  );
  const localDirection = Matrix4.multiplyByPointAsVector(
    inverseLocalFrame,
    worldDirection,
    new Cartesian3()
  );
  Cartesian3.normalize(localDirection, localDirection);
  const horizontal: HorizontalCoordinates = {
    azimuthDegrees:
      ((Math.atan2(localDirection.x, localDirection.y) * 180) / Math.PI + 360) % 360,
    altitudeDegrees:
      (Math.asin(Math.max(-1, Math.min(1, localDirection.z))) * 180) / Math.PI,
  };

  const sample = await photorealisticMeshIntersection(
    viewer,
    observer,
    horizontal,
    signal,
    maximumDistanceMeters
  );
  const obstructed = sample.distanceMeters !== null;
  return {
    verificationState: sample.verified
      ? "dem-and-google-3d"
      : "dem-only",
    visible: sample.verified && !obstructed,
    verified: sample.verified,
    terrainObstructed: false,
    photorealisticMeshObstructed: obstructed,
    reason: !sample.verified
      ? "unverified"
      : obstructed
        ? "building-or-surface"
        : "visible",
    obstructionDistanceMeters: sample.distanceMeters ?? undefined,
  };
}

/** サーバーでDEM可視判定済みの候補に、端末上のGoogle 3D表面判定だけを追加する。 */
export async function evaluatePhotorealisticMeshLineOfSight(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal,
  maximumDistanceMeters?: number,
  discDetail?: {
    angularDiameterDegrees: number;
    detailSettings: BuildingOcclusionDetailSettings;
  }
): Promise<CelestialOcclusion> {
  if (horizontal.altitudeDegrees <= 0) {
    return {
      verificationState: "dem-and-google-3d",
      visible: false,
      verified: true,
      terrainObstructed: false,
      photorealisticMeshObstructed: false,
      reason: "below-horizon",
    };
  }
  const samplePoints = buildDiscSamplePoints(horizontal, discDetail);
  const samples = await Promise.all(
    samplePoints.map((point) =>
      photorealisticMeshIntersection(
        viewer,
        observer,
        point,
        signal,
        maximumDistanceMeters
      )
    )
  );
  const verified = samples.every((sample) => sample.verified);
  const obstructedSamples = samples.filter(
    (sample) => sample.distanceMeters !== null
  );
  const obstructedFractionPercent =
    (obstructedSamples.length / samples.length) * 100;
  // 中心1点しか見ていない従来モードでは、これまでどおり1点でも遮蔽なら遮蔽扱いにする。
  const photorealisticMeshObstructed = samples.length > 1
    ? obstructedFractionPercent >= discDetail!.detailSettings.obstructedThresholdPercent
    : obstructedSamples.length > 0;
  const nearestObstructionDistanceMeters = obstructedSamples.reduce<number | null>(
    (nearest, sample) => {
      if (sample.distanceMeters === null) return nearest;
      return nearest === null ? sample.distanceMeters : Math.min(nearest, sample.distanceMeters);
    },
    null
  );
  return {
    verificationState: verified
      ? "dem-and-google-3d"
      : "dem-only",
    visible: verified && !photorealisticMeshObstructed,
    verified,
    terrainObstructed: false,
    photorealisticMeshObstructed,
    reason: !verified
      ? "unverified"
      : photorealisticMeshObstructed
        ? "building-or-surface"
        : "visible",
    obstructionDistanceMeters: nearestObstructionDistanceMeters ?? undefined,
    obstructedFractionPercent: samples.length > 1 ? obstructedFractionPercent : undefined,
  };
}
