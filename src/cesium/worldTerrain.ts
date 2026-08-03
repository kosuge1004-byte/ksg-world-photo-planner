import {
  Cartographic,
  createWorldTerrainAsync,
  Math as CesiumMath,
  sampleTerrainMostDetailed,
} from "cesium";

import type { GroundPoint } from "../types/points";
import type {
  GsiElevationApiSample,
  TerrainDataSource,
} from "../types/geospatial";
import { publishUserNotice } from "../errors/userFeedback";
import { fetchGsiElevationSamples } from "./gsiElevationClient";

let terrainPromise: ReturnType<typeof createWorldTerrainAsync> | null = null;
const terrainSourceBySample = new WeakMap<Cartographic, TerrainDataSource>();
let gsiUnavailableUntil = 0;
let geoidUnavailableUntil = 0;
let geoidWarningLoggedUntil = 0;
const geoidHeightCache = new Map<string, Promise<number>>();
const GEOID_MEMORY_CACHE_MAX_ENTRIES = 4_096;
const GEOID_CACHE_DB = "ksg-world-photo-planner-geoid-v1";
const GEOID_CACHE_STORE = "geoid";
const GEOID_CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
// 約1kmグリッド。地点ごとの精度を保ちつつ、近接点のAPI要求をまとめる。
const GEOID_REGION_DECIMALS = 2;
type GeoidCacheRecord = { key: string; height: number; updatedAt: number };
type GsiMaximumDetail = "1m" | "5m" | "10m";
type PendingGsiRequest = {
  points: Cartographic[];
  maximumDetails?: GsiMaximumDetail[];
  resolve: (samples: GsiElevationApiSample[]) => void;
  reject: (error: unknown) => void;
};
const pendingGsiRequests = new Map<
  AbortSignal | undefined,
  PendingGsiRequest[]
>();

// 同じ被写体周辺を再検索した際にDEM通信を繰り返さない。
// 約1m単位（緯度経度5桁）でメモリとIndexedDBへ保存する。
const TERRAIN_CACHE_DB = "ksg-world-photo-planner-terrain-v2";
const TERRAIN_CACHE_STORE = "terrain";
const TERRAIN_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const terrainHeightMemoryCache = new Map<string, number>();
const TERRAIN_MEMORY_CACHE_MAX_ENTRIES = 32_768;

type TerrainCacheRecord = { key: string; height: number; updatedAt: number };

function readMemoryCache<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeMemoryCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maximumEntries: number
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

// IndexedDBの実行時APIだけを構造型で扱う。
// TypeScriptのDOM型定義がビルド環境で解決されない場合でも、
// ブラウザ上のIndexedDBキャッシュ動作は維持する。
type KsgIdbRequest<T> = {
  result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
};

type KsgIdbObjectStore = {
  get: (key: string) => KsgIdbRequest<unknown>;
  put: (value: unknown) => KsgIdbRequest<unknown>;
};

type KsgIdbTransaction = {
  objectStore: (name: string) => KsgIdbObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

type KsgIdbDatabase = {
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string, options: { keyPath: string }) => KsgIdbObjectStore;
  transaction: (name: string, mode: "readonly" | "readwrite") => KsgIdbTransaction;
  close: () => void;
};

type KsgIndexedDbFactory = {
  open: (name: string, version: number) => KsgIdbRequest<KsgIdbDatabase>;
};

function getIndexedDbFactory(): KsgIndexedDbFactory | null {
  const runtimeGlobal = globalThis as unknown as { indexedDB?: KsgIndexedDbFactory };
  return runtimeGlobal.indexedDB ?? null;
}

function terrainCacheKey(
  point: Cartographic,
  maximumDetail?: GsiMaximumDetail
): string {
  return [
    CesiumMath.toDegrees(point.latitude).toFixed(5),
    CesiumMath.toDegrees(point.longitude).toFixed(5),
    maximumDetail ?? "auto",
  ].join(",");
}

function openTerrainCache(): Promise<KsgIdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDb.open(TERRAIN_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TERRAIN_CACHE_STORE)) {
        database.createObjectStore(TERRAIN_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readTerrainCache(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[]
): Promise<Array<number | null>> {
  const values = points.map((point, index) =>
    readMemoryCache(
      terrainHeightMemoryCache,
      terrainCacheKey(point, maximumDetails?.[index])
    ) ?? null
  );
  const missing = values.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
  if (missing.length === 0) return values;
  const database = await openTerrainCache();
  if (!database) return values;
  await Promise.all(missing.map((index) => new Promise<void>((resolve) => {
    const key = terrainCacheKey(points[index], maximumDetails?.[index]);
    const request = database.transaction(TERRAIN_CACHE_STORE, "readonly")
      .objectStore(TERRAIN_CACHE_STORE).get(key);
    request.onsuccess = () => {
      const record = request.result as TerrainCacheRecord | undefined;
      if (record && Date.now() - record.updatedAt <= TERRAIN_CACHE_MAX_AGE_MS && Number.isFinite(record.height)) {
        values[index] = record.height;
        writeMemoryCache(
          terrainHeightMemoryCache,
          key,
          record.height,
          TERRAIN_MEMORY_CACHE_MAX_ENTRIES
        );
      }
      resolve();
    };
    request.onerror = () => resolve();
  })));
  database.close();
  return values;
}

async function writeTerrainCache(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[]
): Promise<void> {
  const records = points.flatMap((point, index) => Number.isFinite(point.height)
    ? [{
        key: terrainCacheKey(point, maximumDetails?.[index]),
        height: point.height,
        updatedAt: Date.now(),
      }]
    : []);
  records.forEach((record) => writeMemoryCache(
    terrainHeightMemoryCache,
    record.key,
    record.height,
    TERRAIN_MEMORY_CACHE_MAX_ENTRIES
  ));
  const database = await openTerrainCache();
  if (!database || records.length === 0) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(TERRAIN_CACHE_STORE, "readwrite");
    const store = transaction.objectStore(TERRAIN_CACHE_STORE);
    records.forEach((record) => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

async function sampleTerrainCached(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  const cachedHeights = await readTerrainCache(points, maximumDetails);
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  const missingIndexes: number[] = [];
  cachedHeights.forEach((height, index) => {
    if (height === null) missingIndexes.push(index);
    else result[index].height = height;
  });
  if (missingIndexes.length > 0) {
    const sampled = await sampleTerrainWithGsiPriority(
      missingIndexes.map((index) => points[index]),
      maximumDetails ? missingIndexes.map((index) => maximumDetails[index]) : undefined,
      signal
    );
    sampled.forEach((point, sampledIndex) => {
      result[missingIndexes[sampledIndex]] = point;
    });
    void writeTerrainCache(
      sampled,
      maximumDetails
        ? missingIndexes.map((index) => maximumDetails[index])
        : undefined
    );
  }
  return result;
}

const GSI_SOURCE_NAMES: Record<
  Exclude<GsiElevationApiSample["source"], null>,
  TerrainDataSource
> = {
  DEM1A: "GSI_DEM1A_LIDAR",
  DEM5A: "GSI_DEM5A_LIDAR",
  DEM5B: "GSI_DEM5B_PHOTOGRAMMETRY",
  DEM5C: "GSI_DEM5C_PHOTOGRAMMETRY",
  DEM10B: "GSI_DEM10B_CONTOUR",
};

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("標高取得を中止しました", "AbortError");
}

async function fetchGsiElevations(
  points: Cartographic[],
  maximumDetails?: Array<GsiMaximumDetail | undefined>,
  signal?: AbortSignal
): Promise<GsiElevationApiSample[]> {
  if (Date.now() < gsiUnavailableUntil) {
    return points.map(() => ({ heightMeters: null, source: null }));
  }
  try {
    const result = await fetchGsiElevationSamples(
      points.map((point, index) => ({
        latitude: CesiumMath.toDegrees(point.latitude),
        longitude: CesiumMath.toDegrees(point.longitude),
        maximumDetail: maximumDetails?.[index],
      })),
      signal
    );
    if (result.failedPointCount > 0) {
      const allFailed = result.failedPointCount === points.length;
      if (allFailed) gsiUnavailableUntil = Date.now() + 15_000;
      console.warn(
        `国土地理院DEMの${result.failedPointCount}地点を取得できないためWorld Terrainを使用します`,
        result.lastError
      );
      publishUserNotice({
        key: "gsi-dem-fallback",
        tone: "warning",
        message: allFailed
          ? "国土地理院の詳細地形データを取得できないため、別の地形データで計算を続けています。"
          : `国土地理院の詳細地形データを一部取得できなかったため、${result.failedPointCount}地点だけ別の地形データで補完しています。`,
      });
    }
    return result.samples;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // 予期しないクライアント障害時だけ短時間の連続要求を避ける。
    gsiUnavailableUntil = Date.now() + 15_000;
    console.warn("国土地理院DEMを取得できないためWorld Terrainを使用します", error);
    publishUserNotice({
      key: "gsi-dem-fallback",
      tone: "warning",
      message: "国土地理院の詳細地形データを取得できないため、別の地形データで計算を続けています。",
    });
    return points.map(() => ({ heightMeters: null, source: null }));
  }
}

const GSI_DETAIL_PRIORITY: Record<GsiMaximumDetail, number> = {
  "10m": 0,
  "5m": 1,
  "1m": 2,
};

function finerGsiDetail(
  current: GsiMaximumDetail | undefined,
  candidate: GsiMaximumDetail | undefined
): GsiMaximumDetail | undefined {
  if (!current) return candidate;
  if (!candidate) return current;
  return GSI_DETAIL_PRIORITY[candidate] > GSI_DETAIL_PRIORITY[current]
    ? candidate
    : current;
}

function exactGsiPointKey(point: Cartographic): string {
  // 丸めによる別地点の混同を避けるため、Cesiumが保持するラジアン値をそのまま使用する。
  // 同じ数値座標だけを重複要求として扱い、検索精度は変更しない。
  return `${point.latitude}:${point.longitude}`;
}

async function flushGsiRequests(signal?: AbortSignal): Promise<void> {
  const requests = pendingGsiRequests.get(signal) ?? [];
  pendingGsiRequests.delete(signal);
  if (requests.length === 0) return;
  try {
    abortIfRequested(signal);

    const uniquePoints: Cartographic[] = [];
    const uniqueMaximumDetails: Array<GsiMaximumDetail | undefined> = [];
    const uniqueIndexByKey = new Map<string, number>();
    const requestResultIndexes: number[][] = [];

    for (const request of requests) {
      const resultIndexes: number[] = [];
      request.points.forEach((point, pointIndex) => {
        const key = exactGsiPointKey(point);
        let uniqueIndex = uniqueIndexByKey.get(key);
        if (uniqueIndex === undefined) {
          uniqueIndex = uniquePoints.length;
          uniqueIndexByKey.set(key, uniqueIndex);
          uniquePoints.push(point);
          uniqueMaximumDetails.push(request.maximumDetails?.[pointIndex]);
        } else {
          uniqueMaximumDetails[uniqueIndex] = finerGsiDetail(
            uniqueMaximumDetails[uniqueIndex],
            request.maximumDetails?.[pointIndex]
          );
        }
        resultIndexes.push(uniqueIndex);
      });
      requestResultIndexes.push(resultIndexes);
    }

    const hasMaximumDetails = uniqueMaximumDetails.some((detail) => detail !== undefined);
    const uniqueSamples = await fetchGsiElevations(
      uniquePoints,
      hasMaximumDetails ? uniqueMaximumDetails : undefined,
      signal
    );

    requests.forEach((request, requestIndex) => {
      request.resolve(
        requestResultIndexes[requestIndex].map((uniqueIndex) => uniqueSamples[uniqueIndex])
      );
    });
  } catch (error) {
    for (const request of requests) request.reject(error);
  }
}

function fetchGsiElevationsBatched(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  signal?: AbortSignal
): Promise<GsiElevationApiSample[]> {
  return new Promise((resolve, reject) => {
    const requests = pendingGsiRequests.get(signal);
    const request = { points, maximumDetails, resolve, reject };
    if (requests) {
      requests.push(request);
      return;
    }
    pendingGsiRequests.set(signal, [request]);
    // 同一検索フレームの候補をまとめ、座標やDEM詳細度は一切間引かず通信往復だけを減らす。
    queueMicrotask(() => void flushGsiRequests(signal));
  });
}

function geoidRegionKey(point: Cartographic): string {
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  return `${latitude.toFixed(GEOID_REGION_DECIMALS)},${longitude.toFixed(GEOID_REGION_DECIMALS)}`;
}

function openGeoidCache(): Promise<KsgIdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDb.open(GEOID_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GEOID_CACHE_STORE)) {
        database.createObjectStore(GEOID_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readGeoidPersistentCache(key: string): Promise<number | null> {
  const database = await openGeoidCache();
  if (!database) return null;
  const value = await new Promise<number | null>((resolve) => {
    const request = database.transaction(GEOID_CACHE_STORE, "readonly")
      .objectStore(GEOID_CACHE_STORE).get(key);
    request.onsuccess = () => {
      const record = request.result as GeoidCacheRecord | undefined;
      if (
        record &&
        Date.now() - record.updatedAt <= GEOID_CACHE_MAX_AGE_MS &&
        Number.isFinite(record.height)
      ) {
        resolve(record.height);
      } else {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
  database.close();
  return value;
}

async function writeGeoidPersistentCache(key: string, height: number): Promise<void> {
  const database = await openGeoidCache();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(GEOID_CACHE_STORE, "readwrite");
    transaction.objectStore(GEOID_CACHE_STORE).put({ key, height, updatedAt: Date.now() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

async function fetchGsiGeoidHeight(
  point: Cartographic,
  signal?: AbortSignal
): Promise<number> {
  if (Date.now() < geoidUnavailableUntil) {
    throw new Error("国土地理院ジオイドAPIの再試行待ちです");
  }
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  const key = geoidRegionKey(point);
  const cached = readMemoryCache(geoidHeightCache, key);
  if (cached) return cached;

  const request = (async () => {
    const persistent = await readGeoidPersistentCache(key);
    abortIfRequested(signal);
    if (persistent !== null) return persistent;

    const response = await fetch(
      `/api/gsi-geoid?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
      { headers: { Accept: "application/json" }, signal }
    );
    const data = await response.json() as {
      geoidHeightMeters?: unknown;
      error?: unknown;
    };
    if (
      !response.ok ||
      typeof data.geoidHeightMeters !== "number" ||
      !Number.isFinite(data.geoidHeightMeters)
    ) {
      throw new Error(
        typeof data.error === "string" ? data.error : "ジオイド高を取得できません"
      );
    }
    void writeGeoidPersistentCache(key, data.geoidHeightMeters);
    return data.geoidHeightMeters;
  })().catch((error: unknown) => {
    geoidHeightCache.delete(key);
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      geoidUnavailableUntil = Date.now() + 60_000;
    }
    throw error;
  });
  writeMemoryCache(
    geoidHeightCache,
    key,
    request,
    GEOID_MEMORY_CACHE_MAX_ENTRIES
  );
  return request;
}

async function fetchRegionalGeoidHeights(
  points: Cartographic[],
  eligibleIndexes: number[],
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const representativeByRegion = new Map<string, Cartographic>();
  for (const index of eligibleIndexes) {
    const point = points[index];
    const key = geoidRegionKey(point);
    if (!representativeByRegion.has(key)) representativeByRegion.set(key, point);
  }

  const heights = new Map<string, number>();
  await Promise.all(Array.from(representativeByRegion.entries()).map(async ([key, point]) => {
    try {
      const height = await fetchGsiGeoidHeight(point, signal);
      heights.set(key, height);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (Date.now() >= geoidWarningLoggedUntil) {
        geoidWarningLoggedUntil = Date.now() + 60_000;
        console.warn("一部地域のジオイド高を取得できないため該当地域はWorld Terrainを使用します", error);
      }
    }
  }));
  return heights;
}

export async function sampleWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetail?: GsiMaximumDetail
): Promise<Cartographic[]> {
  return sampleTerrainCached(
    points,
    maximumDetail
      ? points.map(() => maximumDetail)
      : undefined,
    signal
  );
}

/**
 * 最高精度専用。通常検索の距離別詳細度・地域ジオイドキャッシュを通さず、
 * 各地点で利用可能な最詳細DEMと地点固有ジオイドを取得する。
 * どちらかが欠けた場合は標準データへフォールバックせず失敗させる。
 */
export async function sampleWorldTerrainHighestPrecision(
  points: Cartographic[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);
  const requested = points.map((point) => Cartographic.clone(point));
  const elevations = await fetchGsiElevationsBatched(
    requested,
    requested.map(() => "1m"),
    signal
  );
  const results = await Promise.all(requested.map(async (point, index) => {
    const elevation = elevations[index];
    if (
      !elevation?.source ||
      typeof elevation.heightMeters !== "number" ||
      !Number.isFinite(elevation.heightMeters)
    ) {
      throw new Error("利用可能な高精度DEMがありません");
    }
    const latitude = CesiumMath.toDegrees(point.latitude);
    const longitude = CesiumMath.toDegrees(point.longitude);
    const response = await fetch(
      `/api/gsi-geoid?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&precision=point`,
      { headers: { Accept: "application/json" }, signal }
    );
    const data = await response.json() as { geoidHeightMeters?: unknown; error?: unknown };
    if (
      !response.ok ||
      typeof data.geoidHeightMeters !== "number" ||
      !Number.isFinite(data.geoidHeightMeters)
    ) {
      throw new Error(typeof data.error === "string" ? data.error : "地点別ジオイドを取得できません");
    }
    point.height = elevation.heightMeters + data.geoidHeightMeters;
    terrainSourceBySample.set(point, GSI_SOURCE_NAMES[elevation.source]);
    return point;
  }));
  abortIfRequested(signal);
  return results;
}

async function sampleTerrainWithGsiPriority(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  const gsiSamples = await fetchGsiElevationsBatched(
    result,
    maximumDetails,
    signal
  );
  const gsiEligibleIndexes = gsiSamples.map((sample, index) =>
    sample.source !== null &&
    typeof sample.heightMeters === "number" &&
    Number.isFinite(sample.heightMeters)
      ? index
      : -1
  ).filter((index) => index >= 0);
  const geoidHeightByRegion = await fetchRegionalGeoidHeights(
    result,
    gsiEligibleIndexes,
    signal
  );

  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const gsi = gsiSamples[index];
    const geoidHeightMeters = geoidHeightByRegion.get(geoidRegionKey(result[index]));
    if (
      gsi &&
      gsi.source &&
      typeof gsi.heightMeters === "number" &&
      Number.isFinite(gsi.heightMeters) &&
      typeof geoidHeightMeters === "number"
    ) {
      // GSI標高（平均海面基準）へ地域ごとのジオイド高を加え、楕円体高へ統一する。
      result[index].height = gsi.heightMeters + geoidHeightMeters;
      terrainSourceBySample.set(result[index], GSI_SOURCE_NAMES[gsi.source]);
    } else {
      unresolvedIndexes.push(index);
    }
  }
  if (unresolvedIndexes.length === 0) return result;

  abortIfRequested(signal);

  terrainPromise ??= createWorldTerrainAsync({
    requestVertexNormals: false,
    requestWaterMask: false,
  });
  const fallback = await sampleTerrainMostDetailed(
    await terrainPromise,
    unresolvedIndexes.map((index) => result[index])
  );
  abortIfRequested(signal);
  fallback.forEach((sample, fallbackIndex) => {
    const resultIndex = unresolvedIndexes[fallbackIndex];
    result[resultIndex] = sample;
    terrainSourceBySample.set(sample, "CESIUM_WORLD_TERRAIN");
  });
  return result;
}

export async function sampleTerrainLineOfSightProfile(
  points: Cartographic[],
  distancesMeters: number[]
): Promise<Cartographic[]> {
  if (points.length !== distancesMeters.length) {
    throw new Error("地形断面の座標数と距離数が一致しません");
  }
  // 近距離の遮蔽物だけ1m DEMを使い、遠方は必要十分な解像度へ落として通信量を抑える。
  const details = distancesMeters.map((distance) =>
    distance <= 2_000 ? "1m" as const : distance <= 20_000 ? "5m" as const : "10m" as const
  );
  return sampleTerrainCached(points, details);
}

export function terrainDataSource(sample: Cartographic): TerrainDataSource {
  return terrainSourceBySample.get(sample) ?? "CESIUM_WORLD_TERRAIN";
}

export async function groundPointFromCoordinates(
  latitude: number,
  longitude: number,
  label: string
): Promise<GroundPoint> {
  const requested = Cartographic.fromDegrees(longitude, latitude, 0);
  const sampled = (await sampleWorldTerrain([requested]))[0] ?? requested;
  return {
    latitude: CesiumMath.toDegrees(sampled.latitude),
    longitude: CesiumMath.toDegrees(sampled.longitude),
    height: Number.isFinite(sampled.height) ? sampled.height : 0,
    label,
  };
}
