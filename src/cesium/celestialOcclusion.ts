import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Math as CesiumMath,
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
import { directionToHorizontalDegrees, horizontalDirectionToVec3 } from "../projection/projectionService";
import { collectGoogleTilesetsToExclude } from "./googleTilesetMarker";
import { verifyPlateauBuildingBaseHeight } from "./plateauBuildingVerification";
import {
  adaptiveCoarseDistances,
  adaptiveRefinementDistances,
  terrainProfileMaximum,
} from "../geodesy/adaptiveTerrainProfile";
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

/**
 * 3D遮蔽判定に使う情報源。
 * - google-3d: 過去に使っていたモード（Google Photorealistic 3D Tilesの形状データを
 *   直接読み取る）。Googleの利用規約（Map Tiles API Policies）は、そのタイルセットの
 *   形状データをプログラムで読み取る用途（物体検出・ジオデータ抽出等）を明確に禁止して
 *   いるため使用しない。型としては後方互換のために残している。
 * - plateau-verified: 過去に試みたモード（PLATEAU建物＋地点ごとのGSI DEM検証）。
 *   検証ロジックが実際には機能していない疑いがあり（垂直レイが屋根にしか当たらず
 *   接地高さを正しく取得できないケースがあるため）、現在は使用しない。
 *   型としては後方互換のために残している。
 * - none: 3D遮蔽判定を行わない。DEM地形のみで判定する（現在の既定）。
 *   PLATEAUは標準モードの表示専用として使い、遮蔽・検索・標高計算には接続しない
 *   （2026-08-06付けの過去の決定と同じ方針）。
 */
export type ThirdDimensionSource = "google-3d" | "plateau-verified" | "none";

/**
 * 精度モードから3D遮蔽情報源への対応を一本化する。
 * 高精度モードのGoogle Photorealistic 3D Tilesは形状データを遮蔽判定に使わず
 * （Googleの利用規約が禁止しているため）、PLATEAU建物による遮蔽判定も
 * 検証ロジックが信頼できないため使わない（DEM地形のみで判定する）。
 * 標準・高精度どちらのモードでも遮蔽判定の情報源は常に同じ（DEM地形のみ）にする。
 * この対応関係を各呼び出し元で個別に判断させない。
 */
export function thirdDimensionSourceForAccuracyMode(
  _accuracyMode: "standard" | "highest"
): ThirdDimensionSource {
  return "none";
}


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

function profileMaximumWithDataSource(
  observer: CelestialLineOfSightObserver,
  distances: number[],
  samples: Cartographic[]
): TerrainHorizon & { index: number } {
  const shared = terrainProfileMaximum(observer.terrainOrigin, distances, samples);
  return {
    ...shared,
    dataSource: terrainDataSource(samples[shared.index]),
  };
}

async function calculateTerrainHorizon(
  observer: CelestialLineOfSightObserver,
  azimuthDegrees: number,
  signal?: AbortSignal
): Promise<TerrainHorizon> {
  abortIfRequested(signal);
  const coarseDistances = adaptiveCoarseDistances(TERRAIN_DISTANCE_LIMIT_METERS);
  const coarseCoordinates = coarseDistances.map((distance) =>
    destinationCartographic(observer.tripod, azimuthDegrees, distance)
  );
  const coarseSamples = await sampleTerrainLineOfSightProfile(
    coarseCoordinates,
    coarseDistances
  );
  abortIfRequested(signal);
  const coarseMaximum = profileMaximumWithDataSource(observer, coarseDistances, coarseSamples);
  const refinedDistances = adaptiveRefinementDistances(coarseDistances, coarseMaximum.index);
  const refinedCoordinates = refinedDistances.map((distance) =>
    destinationCartographic(observer.tripod, azimuthDegrees, distance)
  );
  const refinedSamples = await sampleTerrainLineOfSightProfile(
    refinedCoordinates,
    refinedDistances
  );
  abortIfRequested(signal);
  const refinedMaximum = profileMaximumWithDataSource(observer, refinedDistances, refinedSamples);
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
  const cached = boundedPromiseCacheGet(terrainHorizonCache, key);
  if (cached) return cached;
  const calculation = calculateTerrainHorizon(observer, azimuthDegrees, signal)
    .catch((error) => {
      terrainHorizonCache.delete(key);
      throw error;
    });
  boundedPromiseCacheSet(
    terrainHorizonCache,
    key,
    calculation,
    MAX_TERRAIN_CACHE_ENTRIES,
  );
  return calculation;
}

export function celestialWorldDirection(
  origin: Cartesian3,
  horizontal: HorizontalCoordinates
): Cartesian3 {
  // ProjectionServiceの唯一の方位/仰角→方向ベクトル変換を経由する
  // （天体・カメラ・LOS方向ベクトルの生成経路を分岐させない）。
  const vec = horizontalDirectionToVec3(horizontal.azimuthDegrees, horizontal.altitudeDegrees);
  const localDirection = new Cartesian3(vec.x, vec.y, vec.z);
  const localFrame = Transforms.eastNorthUpToFixedFrame(origin);
  const worldDirection = Matrix4.multiplyByPointAsVector(
    localFrame,
    localDirection,
    new Cartesian3()
  );
  return Cartesian3.normalize(worldDirection, worldDirection);
}

function boundedPromiseCacheGet<T>(
  cache: Map<string, Promise<T>>,
  key: string,
): Promise<T> | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function boundedPromiseCacheSet<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  value: Promise<T>,
  maximumEntries: number,
): void {
  cache.delete(key);
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
  thirdDimensionSource?: ThirdDimensionSource,
): string {
  return [
    observer.meshOrigin.x,
    observer.meshOrigin.y,
    observer.meshOrigin.z,
    horizontal.azimuthDegrees,
    horizontal.altitudeDegrees,
    maximumDistanceMeters ?? "unbounded",
    thirdDimensionSource ?? "plateau-verified",
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
  thirdDimensionSource: ThirdDimensionSource = "plateau-verified",
): Promise<MeshIntersectionResult> {
  const scene = viewer.scene as RayPickingScene;
  if (
    thirdDimensionSource === "none" ||
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
    // Googleタイルの形状データは遮蔽判定に一切使わない（利用規約上の理由）。
    // thirdDimensionSourceの値に関わらず、シーン内のGoogle由来タイルセットは
    // 常にレイピックの対象から除外する（多層防御）。
    [...viewer.entities.values, ...collectGoogleTilesetsToExclude(viewer)],
    0.12
  );
  const minimumDistance = Math.max(3, observer.lensCenterHeightMeters * 0.75);
  const obstruction = intersections.find((intersection) => {
    if (!intersection.position) return false;
    const distance = Cartesian3.distance(observer.meshOrigin, intersection.position);
    const maximumDistance = maximumDistanceMeters ?? 500_000;
    return distance > minimumDistance && distance < maximumDistance;
  });
  if (!obstruction?.position) {
    return { verified: true, distanceMeters: null };
  }
  if (thirdDimensionSource === "plateau-verified") {
    // 標準モード：交差したPLATEAU建物のその地点だけをGSI DEMと個別に検証する。
    // 全国一律の高さ補正は行わない（過去に撤回した経緯があるため）。検証できない
    // 建物は「遮蔽あり」と断定せず、未確認として扱う。
    const cartographic = Cartographic.fromCartesian(obstruction.position);
    const verification = await verifyPlateauBuildingBaseHeight(
      viewer,
      CesiumMath.toDegrees(cartographic.longitude),
      CesiumMath.toDegrees(cartographic.latitude)
    );
    if (!verification.verified) {
      return { verified: false, distanceMeters: null };
    }
  }
  return {
    verified: true,
    distanceMeters: Cartesian3.distance(observer.meshOrigin, obstruction.position),
  };
}

async function photorealisticMeshIntersection(
  viewer: Viewer,
  observer: CelestialLineOfSightObserver,
  horizontal: HorizontalCoordinates,
  signal?: AbortSignal,
  maximumDistanceMeters?: number,
  thirdDimensionSource: ThirdDimensionSource = "plateau-verified",
): Promise<MeshIntersectionResult> {
  abortIfRequested(signal);
  let viewerCache = meshLineOfSightCache.get(viewer);
  if (!viewerCache) {
    viewerCache = new Map();
    meshLineOfSightCache.set(viewer, viewerCache);
  }
  const key = meshLineOfSightKey(observer, horizontal, maximumDistanceMeters, thirdDimensionSource);
  let calculation = boundedPromiseCacheGet(viewerCache, key);
  if (!calculation) {
    calculation = calculatePhotorealisticMeshIntersection(
      viewer,
      observer,
      horizontal,
      maximumDistanceMeters,
      thirdDimensionSource
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
  let preparation = boundedPromiseCacheGet(viewerCache, key);
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
  thirdDimensionSource: ThirdDimensionSource = "plateau-verified",
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
  const meshPromise: Promise<MeshIntersectionOutcome> | null = thirdDimensionSource !== "none"
    ? photorealisticMeshIntersection(viewer, observer, horizontal, signal, undefined, thirdDimensionSource)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    : null;
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
  if (!meshPromise) return demOnlyResult;

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
  thirdDimensionSource: ThirdDimensionSource = "plateau-verified",
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
  // ProjectionServiceの唯一の方向→方位/仰角変換を経由する（LOSと天体投影で
  // 同じ変換を共有し、計算経路の分岐を防ぐ）。
  const horizontal: HorizontalCoordinates = {
    ...directionToHorizontalDegrees(localDirection),
  };

  const sample = await photorealisticMeshIntersection(
    viewer,
    observer,
    horizontal,
    signal,
    maximumDistanceMeters,
    thirdDimensionSource
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
