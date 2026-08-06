import { createAbortError, isAbortError } from "./runtimeErrors.ts";
import {
  estimateHeightFromTags,
  fetchOverpass,
  localMeters,
  geometryOf,
  numericMeters,
  type OsmElement,
} from "./osmSiteContext.ts";
import { LruPromiseCache } from "./lruPromiseCache.ts";
import { lookupGsiElevations } from "./gsiElevation.ts";
import { effectiveEarthCurvatureDropMeters } from "../src/geodesy/terrestrialRefraction.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";

/**
 * Phase2〜3: 建物・樹木遮蔽強化（DEM+DSM統合）。
 *
 * 国土地理院の標高タイルはDEM（地面のみ）専用で、DSM（樹木・建物込みの
 * 表層モデル）はタイル形式で公開されていない。そのため「DSM統合」は、
 * 既製DSMラスターの取得ではなく、DEM地形の上にOSM由来の地物高さを
 * 加算する方式で実現する。
 *
 * - 建物: height / building:levels タグ（Phase2）
 * - 植生: forest / wood / tree / tree_row / hedge / orchard の height タグ、
 *   なければ種別ごとの代表高で概算（Phase4-3で分類を拡張）
 *
 * ①のDEM地形プロファイルと同じ「見通し線上で最も高く見える点」という
 * 考え方で、サーバー側でも動く軽量な遮蔽判定として統合する。
 *
 * キャッシュ最適化: 建物・樹木を1回のOverpassクエリにまとめて取得し、
 * 結果もひとつのキャッシュエントリに保持する（Phase2では建物のみ・
 * Phase3で樹木を同一クエリに統合）。
 *
 * フォールバック処理: Overpassが失敗しても例外を外へ投げず、
 * 「地物なし」として扱い、DEM地形の判定だけで検索を継続する。
 *
 * Phase4-2以降は各地物の代表点でDEMを取得し、地盤高の近似を削減する。
 * Phase4-3では面状植生・線状植生について頂点だけでなく辺と視線の交差も評価する。
 */

const SURFACE_LOS_MAX_DISTANCE_METERS = 2_000;
const SURFACE_LOS_CORRIDOR_HALF_WIDTH_METERS = 15;

// 樹木は個体ごとの height タグが無いことが多いため、代表的な樹冠高で概算する。
const DEFAULT_FOREST_CANOPY_HEIGHT_METERS = 12;
const DEFAULT_SINGLE_TREE_HEIGHT_METERS = 8;
const DEFAULT_TREE_ROW_HEIGHT_METERS = 9;
const DEFAULT_HEDGE_HEIGHT_METERS = 2;
const DEFAULT_ORCHARD_HEIGHT_METERS = 5;

// Overpassは負荷が高いため、地物は変化が少ないことを踏まえ長期キャッシュする。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const surfaceHorizonCache = new LruPromiseCache<SurfaceObstructionHorizon>({
  maxEntries: 2_048,
  ttlMs: CACHE_TTL_MS,
});

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError("可視判定を中止しました");
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  abortIfRequested(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError("可視判定を中止しました"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

export type SurfaceObstructionOrigin = {
  latitude: number;
  longitude: number;
  groundElevationMeters: number;
  lensCenterHeightMeters: number;
};

export type SurfaceObstructionSource = "building" | "vegetation";
export type VegetationKind = "forest" | "single-tree" | "tree-row" | "hedge" | "orchard";

export type SurfaceObstructionHorizon = {
  maximumElevationDegrees: number;
  distanceMeters: number | null;
  featureName: string | null;
  source: SurfaceObstructionSource | null;
  featureHeightMeters?: number | null;
  heightSource?: "surveyed" | "levels-estimate" | "default-estimate" | null;
  groundElevationSource?: string | null;
  vegetationKind?: VegetationKind | null;
};

function cacheKey(
  origin: SurfaceObstructionOrigin,
  azimuthDegrees: number,
  maximumDistanceMeters: number
): string {
  // Phase4-6: 視線回廊は幅30mのため、約100m格子では別地点の結果を誤共有する。
  // 約1m相当の5桁へ細分化し、同一地点・同一方位の同時要求だけを安全に統合する。
  const latitude = origin.latitude.toFixed(5);
  const longitude = origin.longitude.toFixed(5);
  const azimuth = (Math.round(azimuthDegrees * 2) / 2).toFixed(1);
  const distance = Math.round(Math.min(maximumDistanceMeters, SURFACE_LOS_MAX_DISTANCE_METERS));
  return `${latitude},${longitude},${azimuth},${distance}`;
}

export type SurfaceQueryBounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

/**
 * Phase4-6: 三脚を中心とした円形取得を廃止し、撮影方位に沿う細い回廊だけを
 * Overpassへ要求する。始点・終点と左右余白の四隅をKarney法で求めるため、
 * 高緯度や経度差のある地点でも単純な度換算より安定する。
 */
export function surfaceQueryBounds(
  latitude: number,
  longitude: number,
  azimuthDegrees: number,
  distanceMeters: number,
  corridorHalfWidthMeters = SURFACE_LOS_CORRIDOR_HALF_WIDTH_METERS
): SurfaceQueryBounds {
  const origin = { latitude, longitude, height: 0, label: "surface-query-origin" };
  const endpoint = calculateKarneyDestinationPoint(origin, azimuthDegrees, distanceMeters);
  const corners = [
    calculateKarneyDestinationPoint(origin, azimuthDegrees - 90, corridorHalfWidthMeters),
    calculateKarneyDestinationPoint(origin, azimuthDegrees + 90, corridorHalfWidthMeters),
    calculateKarneyDestinationPoint(endpoint, azimuthDegrees - 90, corridorHalfWidthMeters),
    calculateKarneyDestinationPoint(endpoint, azimuthDegrees + 90, corridorHalfWidthMeters),
  ];
  const latitudes = corners.map((point) => point.latitude);
  const longitudes = corners.map((point) => point.longitude);
  return {
    south: Math.min(...latitudes),
    west: Math.min(...longitudes),
    north: Math.max(...latitudes),
    east: Math.max(...longitudes),
  };
}

function surfaceFeatureQuery(
  latitude: number,
  longitude: number,
  azimuthDegrees: number,
  distanceMeters: number
): string {
  const bounds = surfaceQueryBounds(latitude, longitude, azimuthDegrees, distanceMeters);
  const bbox = `${bounds.south.toFixed(7)},${bounds.west.toFixed(7)},${bounds.north.toFixed(7)},${bounds.east.toFixed(7)}`;
  return `[out:json][timeout:20];(` +
    `way["building"](${bbox});` +
    `nwr["natural"="wood"](${bbox});` +
    `nwr["landuse"="forest"](${bbox});` +
    `nwr["natural"="tree"](${bbox});` +
    `nwr["natural"="tree_row"](${bbox});` +
    `nwr["barrier"="hedge"](${bbox});` +
    `nwr["landuse"="orchard"](${bbox});` +
    `);out tags geom;`;
}

/**
 * ポリゴン/ノードの頂点から、見通し線（方位角の光線）に最も近い点の
 * 「光線に沿った距離」と「光線からの垂直オフセット」を求める。
 */
export function closestApproachToRay(
  element: OsmElement,
  origin: { latitude: number; longitude: number },
  azimuthDegrees: number
): { alongRayMeters: number; perpendicularMeters: number; latitude: number; longitude: number } | null {
  const geometry = geometryOf(element);
  if (geometry.length === 0) return null;
  const azimuthRadians = azimuthDegrees * Math.PI / 180;
  const rayX = Math.sin(azimuthRadians);
  const rayY = Math.cos(azimuthRadians);
  const localPoints = geometry.map((vertex) => ({
    ...localMeters(vertex, origin),
    latitude: vertex.lat,
    longitude: vertex.lon,
  }));

  let best: { alongRayMeters: number; perpendicularMeters: number; latitude: number; longitude: number } | null = null;
  const consider = (x: number, y: number, latitude: number, longitude: number): void => {
    const alongRayMeters = x * rayX + y * rayY;
    if (alongRayMeters <= 0) return;
    const perpendicularMeters = Math.abs(x * rayY - y * rayX);
    if (
      !best ||
      perpendicularMeters < best.perpendicularMeters ||
      (perpendicularMeters === best.perpendicularMeters && alongRayMeters < best.alongRayMeters)
    ) {
      best = { alongRayMeters, perpendicularMeters, latitude, longitude };
    }
  };

  for (const point of localPoints) {
    consider(point.x, point.y, point.latitude, point.longitude);
  }

  // Phase4-3: 頂点だけでなく各辺と視線の交差・最接近点も評価する。
  // 大きな森林ポリゴンや長い生垣を視線が横切る場合の見落としを防ぐ。
  for (let index = 1; index < localPoints.length; index += 1) {
    const a = localPoints[index - 1];
    const b = localPoints[index];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denominator = dx * rayY - dy * rayX;
    if (Math.abs(denominator) > 1e-9) {
      const segmentT = (a.y * rayX - a.x * rayY) / denominator;
      const rayT = (a.x * dy - a.y * dx) / denominator;
      if (segmentT >= 0 && segmentT <= 1 && rayT > 0) {
        consider(
          a.x + segmentT * dx,
          a.y + segmentT * dy,
          a.latitude + segmentT * (b.latitude - a.latitude),
          a.longitude + segmentT * (b.longitude - a.longitude)
        );
      }
    }

    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared > 0) {
      const projected = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
      consider(
        a.x + projected * dx,
        a.y + projected * dy,
        a.latitude + projected * (b.latitude - a.latitude),
        a.longitude + projected * (b.longitude - a.longitude)
      );
    }
  }
  return best;
}

export function elevationAngleDegreesForHeight(
  heightAboveObserverMeters: number,
  distanceMeters: number,
  kFactor = 0.13
): number {
  if (distanceMeters <= 0) return 90;
  // この処理は局所平面距離を使うため、ECEF系とは異なり地球曲率を明示的に差し引く。
  // 有効地球半径 R/(1-k) による落差を使い、地表屈折を一度だけ反映する。
  const curvatureDropMeters = effectiveEarthCurvatureDropMeters(distanceMeters, kFactor);
  return Math.atan2(heightAboveObserverMeters - curvatureDropMeters, distanceMeters) * 180 / Math.PI;
}

/**
 * 地物の種別とタグから遮蔽高さを求める。
 * 建物はPhase2と同じ height / building:levels。
 * 樹木はheightタグを優先し、無ければ種別ごとの典型的な樹冠高で概算する。
 */
function estimateFeatureHeight(
  tags: Record<string, string>
): {
  heightMeters: number;
  source: SurfaceObstructionSource;
  heightSource: "surveyed" | "levels-estimate" | "default-estimate";
  vegetationKind: VegetationKind | null;
} | null {
  if (tags.building) {
    const { heightMeters, heightSource } = estimateHeightFromTags(tags);
    return heightMeters !== null && heightMeters > 0 && heightSource
      ? { heightMeters, source: "building", heightSource, vegetationKind: null }
      : null;
  }

  const vegetationKind: VegetationKind | null =
    tags.natural === "tree" ? "single-tree" :
    tags.natural === "tree_row" ? "tree-row" :
    tags.barrier === "hedge" ? "hedge" :
    tags.landuse === "orchard" ? "orchard" :
    tags.natural === "wood" || tags.landuse === "forest" ? "forest" :
    null;
  if (!vegetationKind) return null;

  const mappedHeight = numericMeters(tags.height);
  const defaultHeightMeters =
    vegetationKind === "single-tree" ? DEFAULT_SINGLE_TREE_HEIGHT_METERS :
    vegetationKind === "tree-row" ? DEFAULT_TREE_ROW_HEIGHT_METERS :
    vegetationKind === "hedge" ? DEFAULT_HEDGE_HEIGHT_METERS :
    vegetationKind === "orchard" ? DEFAULT_ORCHARD_HEIGHT_METERS :
    DEFAULT_FOREST_CANOPY_HEIGHT_METERS;

  return {
    heightMeters: mappedHeight ?? defaultHeightMeters,
    source: "vegetation",
    heightSource: mappedHeight !== null ? "surveyed" : "default-estimate",
    vegetationKind,
  };
}

async function computeSurfaceObstructionHorizon(
  origin: SurfaceObstructionOrigin,
  azimuthDegrees: number,
  maximumDistanceMeters: number,
  signal?: AbortSignal
): Promise<SurfaceObstructionHorizon> {
  const empty = { maximumElevationDegrees: -90, distanceMeters: null, featureName: null, source: null } as const;
  const searchRadiusMeters = Math.min(maximumDistanceMeters, SURFACE_LOS_MAX_DISTANCE_METERS);
  if (searchRadiusMeters <= 0) return empty;

  const elements = await fetchOverpass(
    surfaceFeatureQuery(
      origin.latitude,
      origin.longitude,
      azimuthDegrees,
      searchRadiusMeters
    ),
    signal
  );

  const candidates: Array<{
    featureName: string | null;
    feature: NonNullable<ReturnType<typeof estimateFeatureHeight>>;
    approach: NonNullable<ReturnType<typeof closestApproachToRay>>;
  }> = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const feature = estimateFeatureHeight(tags);
    if (!feature) continue;
    const approach = closestApproachToRay(element, origin, azimuthDegrees);
    if (!approach) continue;
    if (approach.perpendicularMeters > SURFACE_LOS_CORRIDOR_HALF_WIDTH_METERS) continue;
    if (approach.alongRayMeters > searchRadiusMeters) continue;
    // Phase6-2: 巨大なOSM tagsオブジェクト全体をDEM取得完了まで保持しない。
    // 結果表示に必要な名称だけを取り出し、候補1件あたりの保持量を削減する。
    candidates.push({
      featureName: tags["name:ja"] ?? tags.name ?? null,
      feature,
      approach,
    });
    if (candidates.length >= 2_048) break;
  }
  if (candidates.length === 0) return empty;

  // Phase4-2: 各地物の代表点でDEMを取得し、三脚地点の地盤高で代用しない。
  // GSI範囲外・欠測時のみ従来どおり三脚地盤高へフォールバックする。
  const groundSamples = await lookupGsiElevations(
    candidates.map(({ approach }) => ({
      latitude: approach.latitude,
      longitude: approach.longitude,
      maximumDetail: "5m" as const,
    })),
    signal
  );

  const observerHeightMeters = origin.groundElevationMeters + origin.lensCenterHeightMeters;
  let result: SurfaceObstructionHorizon = { ...empty };
  candidates.forEach(({ featureName, feature, approach }, index) => {
    const sample = groundSamples[index];
    const featureGroundMeters = sample?.heightMeters ?? origin.groundElevationMeters;
    const topHeightAboveObserverMeters =
      featureGroundMeters + feature.heightMeters - observerHeightMeters;
    const elevationDegrees = elevationAngleDegreesForHeight(
      topHeightAboveObserverMeters,
      approach.alongRayMeters
    );
    if (elevationDegrees > result.maximumElevationDegrees) {
      result = {
        maximumElevationDegrees: elevationDegrees,
        distanceMeters: approach.alongRayMeters,
        featureName,
        source: feature.source,
        featureHeightMeters: feature.heightMeters,
        heightSource: feature.heightSource,
        groundElevationSource: sample?.source ?? null,
        vegetationKind: feature.vegetationKind,
      };
    }
  });
  return result;
}

/**
 * 三脚位置・方位角から見た建物・樹木の見通し線上の最大仰角を求める（キャッシュ付き）。
 * DEM地形プロファイルの結果とは呼び出し側で Math.max により統合する想定。
 */
export async function lookupSurfaceObstructionHorizon(
  origin: SurfaceObstructionOrigin,
  azimuthDegrees: number,
  maximumDistanceMeters: number,
  signal?: AbortSignal
): Promise<SurfaceObstructionHorizon> {
  if (
    !Number.isFinite(origin.latitude) ||
    !Number.isFinite(origin.longitude) ||
    !Number.isFinite(azimuthDegrees) ||
    !Number.isFinite(maximumDistanceMeters)
  ) {
    return { maximumElevationDegrees: -90, distanceMeters: null, featureName: null, source: null };
  }
  const key = cacheKey(origin, azimuthDegrees, maximumDistanceMeters);
  try {
    // Phase6-1: 共有キャッシュ内の処理へ呼出元signalを渡さない。
    // 1件のキャンセルで同じLOSを待つ他リクエストまで失敗することを防ぎ、
    // 呼出元だけをawaitWithAbortで即時中止する。
    const pending = surfaceHorizonCache.getOrCreate(key, () =>
      computeSurfaceObstructionHorizon(origin, azimuthDegrees, maximumDistanceMeters)
    );
    return await awaitWithAbort(pending, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Overpassが失敗しても検索全体は継続する（フォールバック処理：
    // 建物・樹木遮蔽は追加情報として扱い、DEM地形の判定のみで続行する）。
    return { maximumElevationDegrees: -90, distanceMeters: null, featureName: null, source: null };
  }
}
