import { createAbortError, createTimeoutError, isAbortError } from "../utils/runtimeErrors";
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
import { prefetchGsiDeviceTilesForSamples, resolveGsiSamplesFromDeviceTiles } from "./gsiDemTileCache";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { shareInFlightRequest } from "../network/sharedRequests";

let terrainPromise: ReturnType<typeof createWorldTerrainAsync> | null = null;
const terrainSourceBySample = new WeakMap<Cartographic, TerrainDataSource>();
const geoidHeightBySample = new WeakMap<Cartographic, number>();
let gsiUnavailableUntil = 0;
let geoidUnavailableUntil = 0;
let geoidWarningLoggedUntil = 0;
const GEOID_FETCH_TIMEOUT_MS = 15_000;
const WORLD_TERRAIN_MAX_ATTEMPTS = 3;
const WORLD_TERRAIN_RETRY_DELAYS_MS = [250, 700] as const;
// Cesiumのprovider生成/sampleTerrainMostDetailedにはAbortSignalも標準の
// タイムアウトもない。GSIフォールバック時に1要求が永久待ちにならないよう、
// 各試行の「待機」だけを制限し、同じ最詳細データ・同じ座標で再試行する。
const WORLD_TERRAIN_OPERATION_TIMEOUT_MS = 30_000;
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
// 2026-08-28追記: interpolationMode（los-safe/neutral）ごとに別々の
// バッチへ分ける。同じsignal（同じ検索セッション）内でも、モードが
// 違うリクエストを1つのバッチに混ぜてしまうと、地形によっては数十cm～
// 数m異なりうる、精度に直結する値が誤って共有されるリスクがある。
// signalはオブジェクト参照のため文字列化できず、interpolationModeとの
// 複合キーには「signal→(mode→requests)」のネストしたMapを使う。
const pendingGsiRequests = new Map<
  AbortSignal | undefined,
  Map<"los-safe" | "neutral", PendingGsiRequest[]>
>();

// 同じ被写体周辺を再検索した際にDEM通信を繰り返さない。
// 約1m単位（緯度経度5桁）でメモリとIndexedDBへ保存する。
const TERRAIN_CACHE_DB = "ksg-world-photo-planner-terrain-v3";
const TERRAIN_CACHE_STORE = "terrain";
const TERRAIN_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
type TerrainCachedHeight = { height: number; geoidHeightMeters?: number };
const terrainHeightMemoryCache = new Map<string, TerrainCachedHeight>();
const TERRAIN_MEMORY_CACHE_MAX_ENTRIES = 32_768;

type TerrainCacheRecord = {
  key: string;
  height: number;
  geoidHeightMeters?: number;
  datum: "ellipsoidal-v1";
  updatedAt: number;
};

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
  onblocked?: (() => void) | null;
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
  onversionchange?: (() => void) | null;
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
  maximumDetail?: GsiMaximumDetail,
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): string {
  return [
    CesiumMath.toDegrees(point.latitude).toFixed(5),
    CesiumMath.toDegrees(point.longitude).toFixed(5),
    maximumDetail ?? "auto",
    // 2026-08-28追記: los-safe（バイリニア/バイキュービックの高い方を
    // 採用する安全側の補間）とneutral（バイキュービックの値をそのまま
    // 使う中立な補間）は、地形によっては数十cm～数m異なりうる、精度に
    // 直結する別の値。キャッシュキーに含めず混用すると、三脚探索の
    // 精度が気づかないうちに劣化する重大なリスクがあるため、必ず
    // キーに含めて区別する。
    interpolationMode,
  ].join(",");
}

let terrainCacheDatabasePromise: Promise<KsgIdbDatabase | null> | null = null;
// Terrain IndexedDB is only a performance layer. Android WebView can leave an
// open/transaction request blocked or a previously opened connection can become
// invalid. Never allow that cache state to abort or stall the authoritative DEM path.
const TERRAIN_CACHE_OPEN_TIMEOUT_MS = 1_500;
const TERRAIN_CACHE_OPERATION_TIMEOUT_MS = 1_500;

function boundedTerrainCacheOperation<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = globalThis.setTimeout(
      () => finish(fallback),
      TERRAIN_CACHE_OPERATION_TIMEOUT_MS
    );
    void operation.then(finish, () => finish(fallback));
  });
}

function openTerrainCache(): Promise<KsgIdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  if (terrainCacheDatabasePromise) return terrainCacheDatabasePromise;

  const opening = new Promise<KsgIdbDatabase | null>((resolve) => {
    let settled = false;
    let request: KsgIdbRequest<KsgIdbDatabase>;
    const finish = (database: KsgIdbDatabase | null) => {
      if (settled) {
        if (database) database.close();
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(database);
    };
    const timeoutId = globalThis.setTimeout(() => finish(null), TERRAIN_CACHE_OPEN_TIMEOUT_MS);
    try {
      request = indexedDb.open(TERRAIN_CACHE_DB, 1);
    } catch {
      finish(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TERRAIN_CACHE_STORE)) {
        database.createObjectStore(TERRAIN_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        terrainCacheDatabasePromise = null;
      };
      finish(database);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
  terrainCacheDatabasePromise = opening;
  void opening.then((database) => {
    if (!database && terrainCacheDatabasePromise === opening) {
      terrainCacheDatabasePromise = null;
    }
  });
  return opening;
}

async function readTerrainCache(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<Array<TerrainCachedHeight | null>> {
  const values = points.map((point, index) =>
    readMemoryCache(
      terrainHeightMemoryCache,
      terrainCacheKey(point, maximumDetails?.[index], interpolationMode)
    ) ?? null
  );
  const missing = values.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
  if (missing.length === 0) return values;
  const database = await openTerrainCache();
  if (!database) return values;
  // 1地点ごとにIndexedDB transactionを作ると、LOSや三脚候補のような
  // 多点取得で数十～数百個のtransaction完了イベントが発生し、スマホの
  // メインスレッドを圧迫する。同一バッチは1つのreadonly transaction/storeを
  // 共有し、結果・キャッシュ精度を一切変えずにI/Oオーバーヘッドだけ削減する。
  try {
    const transaction = database.transaction(TERRAIN_CACHE_STORE, "readonly");
    const store = transaction.objectStore(TERRAIN_CACHE_STORE);
    await boundedTerrainCacheOperation(
      Promise.all(missing.map((index) => new Promise<void>((resolve) => {
        const key = terrainCacheKey(points[index], maximumDetails?.[index], interpolationMode);
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result as TerrainCacheRecord | undefined;
          if (
            record &&
            record.datum === "ellipsoidal-v1" &&
            Date.now() - record.updatedAt <= TERRAIN_CACHE_MAX_AGE_MS &&
            Number.isFinite(record.height)
          ) {
            const cached: TerrainCachedHeight = {
              height: record.height,
              geoidHeightMeters: Number.isFinite(record.geoidHeightMeters)
                ? record.geoidHeightMeters
                : undefined,
            };
            values[index] = cached;
            writeMemoryCache(
              terrainHeightMemoryCache,
              key,
              cached,
              TERRAIN_MEMORY_CACHE_MAX_ENTRIES
            );
          }
          resolve();
        };
        request.onerror = () => resolve();
      }))),
      []
    );
  } catch {
    // InvalidStateError/TransactionInactiveError etc. mean only that this optional
    // cache connection is unusable. Drop it and continue through local DEM/network.
    terrainCacheDatabasePromise = null;
  }
  return values;
}

async function writeTerrainCache(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<void> {
  const records: TerrainCacheRecord[] = points.flatMap((point, index) => Number.isFinite(point.height)
    ? [{
        key: terrainCacheKey(point, maximumDetails?.[index], interpolationMode),
        height: point.height,
        geoidHeightMeters: geoidHeightBySample.get(point),
        datum: "ellipsoidal-v1" as const,
        updatedAt: Date.now(),
      }]
    : []);
  records.forEach((record) => writeMemoryCache(
    terrainHeightMemoryCache,
    record.key,
    {
      height: record.height,
      geoidHeightMeters: record.geoidHeightMeters,
    },
    TERRAIN_MEMORY_CACHE_MAX_ENTRIES
  ));
  const database = await openTerrainCache();
  if (!database || records.length === 0) return;
  try {
    await boundedTerrainCacheOperation(
      new Promise<void>((resolve) => {
        const transaction = database.transaction(TERRAIN_CACHE_STORE, "readwrite");
        const store = transaction.objectStore(TERRAIN_CACHE_STORE);
        records.forEach((record) => store.put(record));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      }),
      undefined
    );
  } catch {
    terrainCacheDatabasePromise = null;
  }
}

async function sampleTerrainCached(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  signal?: AbortSignal,
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  const cachedHeights = await readTerrainCache(points, maximumDetails, interpolationMode);
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  const missingIndexes: number[] = [];
  cachedHeights.forEach((cached, index) => {
    if (cached === null) {
      missingIndexes.push(index);
      return;
    }
    result[index].height = cached.height;
    if (Number.isFinite(cached.geoidHeightMeters)) {
      geoidHeightBySample.set(result[index], cached.geoidHeightMeters as number);
    }
  });
  if (missingIndexes.length > 0) {
    const missingPoints = missingIndexes.map((index) => points[index]);
    const missingMaximumDetails = maximumDetails
      ? missingIndexes.map((index) => maximumDetails[index])
      : undefined;

    // 2026-08-29: Before using the network, try the decoded DEM tile cache.
    // This path never rounds coordinates and only returns a value when all tiles
    // required to reproduce the server decision are present; otherwise it safely
    // falls through to the existing API.
    const localSamples = await resolveGsiSamplesFromDeviceTiles(
      missingPoints.map((point, index) => ({
        latitude: CesiumMath.toDegrees(point.latitude),
        longitude: CesiumMath.toDegrees(point.longitude),
        maximumDetail: missingMaximumDetails?.[index],
        interpolationMode,
      }))
    );
    abortIfRequested(signal);

    // Device DEM tiles store the raw GSI elevation H (orthometric height).
    // Cartographic.height everywhere downstream is ellipsoidal h, so a local tile hit
    // must undergo the same h = H + N conversion as the network path. The previous
    // implementation assigned H directly to Cartographic.height; around the reproduced
    // site N is ~38.1 m, exactly matching the observed cached-vs-no-cache offset.
    const localResolvedIndexes = localSamples
      .map((sample, localIndex) =>
        sample !== null && sample.heightMeters !== null ? localIndex : -1
      )
      .filter((localIndex) => localIndex >= 0);
    const localGeoidByRegion = await fetchRegionalGeoidHeights(
      missingPoints,
      localResolvedIndexes,
      signal
    );
    abortIfRequested(signal);

    const networkLocalIndexes: number[] = [];
    localSamples.forEach((sample, localIndex) => {
      if (sample === null || sample.heightMeters === null) {
        networkLocalIndexes.push(localIndex);
        return;
      }
      const point = missingPoints[localIndex];
      const geoidHeightMeters = localGeoidByRegion.get(geoidRegionKey(point));
      if (!Number.isFinite(geoidHeightMeters)) {
        // Never reinterpret orthometric H as ellipsoidal h. If N is unavailable,
        // fall through to the authoritative network path instead.
        networkLocalIndexes.push(localIndex);
        return;
      }
      const originalIndex = missingIndexes[localIndex];
      result[originalIndex].height = sample.heightMeters + (geoidHeightMeters as number);
      geoidHeightBySample.set(result[originalIndex], geoidHeightMeters as number);
      if (sample.source) {
        const source = GSI_SOURCE_NAMES[sample.source];
        if (source) terrainSourceBySample.set(result[originalIndex], source);
      }
    });

    if (networkLocalIndexes.length > 0) {
      const networkPoints = networkLocalIndexes.map((localIndex) => missingPoints[localIndex]);
      const networkMaximumDetails = missingMaximumDetails
        ? networkLocalIndexes.map((localIndex) => missingMaximumDetails[localIndex])
        : undefined;
      const sampled = await sampleTerrainWithGsiPriority(
        networkPoints,
        networkMaximumDetails,
        signal,
        interpolationMode
      );
      sampled.forEach((point, networkIndex) => {
        const localIndex = networkLocalIndexes[networkIndex];
        result[missingIndexes[localIndex]] = point;
      });
      void writeTerrainCache(sampled, networkMaximumDetails, interpolationMode);
    }
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
  if (signal?.aborted) throw createAbortError("標高取得を中止しました");
}

async function fetchGsiElevations(
  points: Cartographic[],
  maximumDetails?: Array<GsiMaximumDetail | undefined>,
  signal?: AbortSignal,
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<GsiElevationApiSample[]> {
  if (Date.now() < gsiUnavailableUntil) {
    return points.map(() => ({ heightMeters: null, source: null }));
  }
  try {
    const clientPoints = points.map((point, index) => ({
      latitude: CesiumMath.toDegrees(point.latitude),
      longitude: CesiumMath.toDegrees(point.longitude),
      maximumDetail: maximumDetails?.[index],
      interpolationMode,
    }));
    const result = await fetchGsiElevationSamples(clientPoints, signal);
    // Warm decoded tiles only after the authoritative API result is available.
    // This never delays the current search and makes later nearby searches local-first.
    prefetchGsiDeviceTilesForSamples(clientPoints, result.samples);
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
    if (isAbortError(error)) throw error;
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

function exactGsiPointKey(point: Cartographic, interpolationMode: "los-safe" | "neutral"): string {
  // 丸めによる別地点の混同を避けるため、Cesiumが保持するラジアン値をそのまま使用する。
  // 同じ数値座標だけを重複要求として扱い、検索精度は変更しない。
  // interpolationModeが違えば、地形によっては数十cm～数m異なりうる別の
  // 値になるため、同じ座標でも必ず別のキーとして扱う。
  return `${point.latitude}:${point.longitude}:${interpolationMode}`;
}

async function flushGsiRequests(signal: AbortSignal | undefined, interpolationMode: "los-safe" | "neutral"): Promise<void> {
  const bySignal = pendingGsiRequests.get(signal);
  const requests = bySignal?.get(interpolationMode) ?? [];
  if (bySignal) {
    bySignal.delete(interpolationMode);
    if (bySignal.size === 0) pendingGsiRequests.delete(signal);
  }
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
        const key = exactGsiPointKey(point, interpolationMode);
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
      signal,
      interpolationMode
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
  signal?: AbortSignal,
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<GsiElevationApiSample[]> {
  return new Promise((resolve, reject) => {
    let bySignal = pendingGsiRequests.get(signal);
    if (!bySignal) {
      bySignal = new Map();
      pendingGsiRequests.set(signal, bySignal);
    }
    const requests = bySignal.get(interpolationMode);
    const request = { points, maximumDetails, resolve, reject };
    if (requests) {
      requests.push(request);
      return;
    }
    bySignal.set(interpolationMode, [request]);
    // 同一検索フレームの候補をまとめ、座標やDEM詳細度は一切間引かず通信往復だけを減らす。
    queueMicrotask(() => void flushGsiRequests(signal, interpolationMode));
  });
}

function geoidRegionKey(point: Cartographic): string {
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  return `${latitude.toFixed(GEOID_REGION_DECIMALS)},${longitude.toFixed(GEOID_REGION_DECIMALS)}`;
}

let geoidCacheDatabasePromise: Promise<KsgIdbDatabase | null> | null = null;

function openGeoidCache(): Promise<KsgIdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  // 同じ計算中に地域ごとにDBをopen/closeすると、IndexedDBの接続確立イベントが
  // メインスレッドへ大量に戻る。DB接続だけを共有し、保存値・キー・有効期限は
  // 従来のまま維持するため、地形/ジオイド精度には影響しない。
  geoidCacheDatabasePromise ??= new Promise((resolve) => {
    const request = indexedDb.open(GEOID_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GEOID_CACHE_STORE)) {
        database.createObjectStore(GEOID_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        geoidCacheDatabasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      geoidCacheDatabasePromise = null;
      resolve(null);
    };
  });
  return geoidCacheDatabasePromise;
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
}

async function fetchGsiGeoidHeightOnce(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  pointSpecific = false,
  timeoutMs = GEOID_FETCH_TIMEOUT_MS
): Promise<number> {
  // 国土地理院ジオイドCGIは応答が不安定なことがあり、タイムアウトが
  // 無いとハングして無期限に待ち続けてしまう（実際に発生していた
  // 「数分待っても描画されない」不具合の主因の1つ）。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(
    `/api/gsi-geoid?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}${pointSpecific ? "&precision=point" : ""}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    }
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
  return data.geoidHeightMeters;
}

// 2026-09-01追記: 従来はgeoidUnavailableUntil中のジオイド取得を即座に
// 失敗させていた。しかし三脚候補の精密化（refineWithManualEquivalentProjection）
// はジオイド取得の失敗をそのまま候補全体の棄却に使っており、無関係な
// 地点・無関係な検索で先に起きた一時的なAPI不調（8秒間のブレーカー）が、
// 既に得られている粗い解（seed）ごと候補を消してしまう実害が実機診断で
// 確認された。ブレーカーは「即失敗」ではなく「解除まで待ってから通常どおり
// 試す」方式にし、瞬間的な不調からの回復を優先する。ブレーカーの残り時間は
// 設計上常に8秒以内のため、待ち時間の上限も自明に抑えられる。
async function waitForGeoidBreakerToClear(signal?: AbortSignal): Promise<void> {
  const remainingMs = geoidUnavailableUntil - Date.now();
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, remainingMs);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchGsiGeoidHeight(
  point: Cartographic,
  signal?: AbortSignal
): Promise<number> {
  await waitForGeoidBreakerToClear(signal);
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  const key = geoidRegionKey(point);
  const cached = readMemoryCache(geoidHeightCache, key);
  if (cached) return cached;

  const request = (async () => {
    const persistent = await readGeoidPersistentCache(key);
    abortIfRequested(signal);
    if (persistent !== null) return persistent;

    // サーバー側で既にGSI CGIへの再試行は行っているが、端末〜Cloudflare間の
    // 一時的な通信の乱れはサーバー再試行では救えないため、ここでも1回だけ
    // 短い間隔を空けて再試行する。
    try {
      const height = await fetchGsiGeoidHeightOnce(latitude, longitude, signal);
      void writeGeoidPersistentCache(key, height);
      return height;
    } catch {
      abortIfRequested(signal);
      await new Promise((resolve) => setTimeout(resolve, 400));
      abortIfRequested(signal);
      const height = await fetchGsiGeoidHeightOnce(latitude, longitude, signal);
      void writeGeoidPersistentCache(key, height);
      return height;
    }
  })().catch((error: unknown) => {
    geoidHeightCache.delete(key);
    if (!(isAbortError(error))) {
      // 1回の失敗で長時間ブロックすると、それだけで「頻繁にエラーが出る」体感を
      // 生んでしまうため、短い間隔にとどめる（連続失敗時の最低限の配慮のみ）。
      geoidUnavailableUntil = Date.now() + 8_000;
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

/**
 * 三脚候補の最終判定など、数cm級の高さ整合が必要な地点専用。
 * 0.01度の地域代表値ではなく、その緯度経度自身をGSIジオイド計算へ渡す。
 * キャッシュキーのみ約11m相当（4桁）へ量子化し、被写体や別候補のN値を流用しない。
 *
 * 2026-08-25追記: 以前はキャッシュキーを8桁（約1mm）で量子化しており、
 * 三脚探索の候補座標は反復計算のたびに1mm単位ではほぼ確実に変わるため、
 * 「同じ場所を何度検索してもキャッシュがほぼ毎回外れ、国土地理院の
 * レート制限（3.5秒/回）に毎回引っかかって数十秒待たされる」原因になって
 * いた。ジオイド高は11m程度の範囲ではミリ未満しか変化しない滑らかな量
 * であり、この関数がコメントで要求している「数cm級」の精度には
 * 11mへの量子化は影響しない（実際にGSIへ問い合わせる座標は従来どおり
 * 丸めていない原座標のまま送るため、値そのものの精度も変わらない）。
 */
export async function fetchGsiGeoidHeightPointSpecific(
  point: Cartographic,
  signal?: AbortSignal,
  timeoutMs = GEOID_FETCH_TIMEOUT_MS
): Promise<number> {
  await waitForGeoidBreakerToClear(signal);
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  const key = `point:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const cached = readMemoryCache(geoidHeightCache, key);
  if (cached) return cached;

  const request = (async () => {
    const persistent = await readGeoidPersistentCache(key);
    abortIfRequested(signal);
    if (persistent !== null) return persistent;
    const height = await fetchGsiGeoidHeightOnce(latitude, longitude, signal, true, timeoutMs);
    void writeGeoidPersistentCache(key, height);
    return height;
  })().catch((error: unknown) => {
    geoidHeightCache.delete(key);
    if (!isAbortError(error)) geoidUnavailableUntil = Date.now() + 8_000;
    throw error;
  });
  writeMemoryCache(geoidHeightCache, key, request, GEOID_MEMORY_CACHE_MAX_ENTRIES);
  return request;
}

/** DEMサンプルを楕円体高へ変換する際に実際に使用したジオイド高N。 */
export function geoidHeightMetersForTerrainSample(sample: Cartographic): number | undefined {
  return geoidHeightBySample.get(sample);
}

/**
 * テスト専用: 実際の地形取得（sampleWorldTerrainNeutral等）を経由せず、
 * 特定のCartographicへジオイド高を直接紐づける。本番のロジックは
 * server/worldTerrain.ts内の地形取得処理が自動的にgeoidHeightBySample.set()
 * を呼ぶため、この関数は使わない（単体テストで、地形取得を経由しない
 * 座標に対してジオイド高が正しく引き継がれることを検証するためだけに存在する）。
 */
export function __setGeoidHeightForTesting(sample: Cartographic, geoidHeightMeters: number): void {
  geoidHeightBySample.set(sample, geoidHeightMeters);
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
      if (isAbortError(error)) throw error;
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
 * Googleタイルモード専用。通常検索の距離別詳細度・地域ジオイドキャッシュを通さず、
 * 各地点で利用可能な最詳細DEMと地点固有ジオイドを取得する。
 * どちらかが欠けた場合は標準データへフォールバックせず失敗させる。
 */

/**
 * 三脚候補など、地形との交点そのものを位置として解く用途専用。
 * GSI 1m DEMの補間でLOS用の上方バイアス(max(bilinear,bicubic))を使わず、
 * 制約付きBicubicの中立補間値を使用する。GSI欠測時のWorld Terrain
 * フォールバック、ジオイド→楕円体高変換は通常sampleWorldTerrainと同一。
 *
 * 2026-08-28追記: 以前はsampleTerrainCached（端末IndexedDB永続キャッシュ）
 * を経由せず、毎回直接fetchGsiElevationSamplesへ問い合わせていたため、
 * 過去に検索したことのある地点でも、三脚探索では通信が毎回発生していた。
 * sampleTerrainWithGsiPriorityは、通常のsampleWorldTerrainと完全に
 * 同じ処理（GSI標高取得→ジオイド変換→World Terrainフォールバック）を、
 * interpolationModeを引数として受け取れる形で持っているため、それを
 * そのまま呼ぶ形に置き換える。interpolationMode（los-safe/neutral）は
 * キャッシュキーに含まれるため（terrainCacheKey参照）、既存の
 * sampleWorldTerrain用のキャッシュと混同されることはない。
 */
export async function sampleWorldTerrainNeutral(
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetail?: GsiMaximumDetail
): Promise<Cartographic[]> {
  return sampleTerrainCached(
    points,
    maximumDetail
      ? points.map(() => maximumDetail)
      : undefined,
    signal,
    "neutral"
  );
}

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
  const geoidPoints = requested.map((point) => ({
    latitude: CesiumMath.toDegrees(point.latitude),
    longitude: CesiumMath.toDegrees(point.longitude),
  }));
  // 通信・計算には倍精度の原座標を使い、同時要求共有キーだけ約11m相当（4桁）に
  // 量子化する（fetchGsiGeoidHeightPointSpecific・server/gsiGeoid.tsと精度を統一）。
  const geoidKeyPoints = geoidPoints.map((point) => ({
    latitude: Number(point.latitude.toFixed(4)),
    longitude: Number(point.longitude.toFixed(4)),
  }));
  const geoidKey = `gsi-geoid-point-batch:${geoidKeyPoints.map((point) => `${point.latitude},${point.longitude}`).join(";")}`;
  const geoidHeights = await shareInFlightRequest({
    key: geoidKey,
    category: "gsi-geoid",
    signal,
    factory: async () => {
      const response = await diagnosticFetch("gsi-geoid", "/api/gsi-geoid", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ points: geoidPoints, precision: "point" }),
      });
      const data = await response.json() as { geoidHeightMeters?: unknown[]; error?: unknown };
      if (!response.ok || !Array.isArray(data.geoidHeightMeters)) {
        throw new Error(typeof data.error === "string" ? data.error : "地点別ジオイドを取得できません");
      }
      const values = data.geoidHeightMeters.map(Number);
      if (values.length !== requested.length || values.some((value) => !Number.isFinite(value))) {
        throw new Error("地点別ジオイドAPIの応答件数または値が不正です");
      }
      return values;
    },
  });
  const results = requested.map((point, index) => {
    const elevation = elevations[index];
    if (
      !elevation?.source ||
      typeof elevation.heightMeters !== "number" ||
      !Number.isFinite(elevation.heightMeters)
    ) {
      throw new Error("利用可能なGoogleタイルモードDEMがありません");
    }
    point.height = elevation.heightMeters + geoidHeights[index];
    terrainSourceBySample.set(point, GSI_SOURCE_NAMES[elevation.source]);
    geoidHeightBySample.set(point, geoidHeights[index]);
    return point;
  });
  abortIfRequested(signal);
  return results;
}

/**
 * sampleWorldTerrainHighestPrecision()が取得した地点固有ジオイド高を返す。
 * 標高（orthometricHeightMeters）を楕円体高から正しく逆算するために使う。
 * 未取得の場合は例外にする（0m相当のフォールバックはしない）。
 */
export function geoidHeightMetersForHighestPrecisionSample(sample: Cartographic): number {
  const value = geoidHeightBySample.get(sample);
  if (value === undefined) {
    throw new Error("この地点のGoogleタイルモードジオイド高は取得されていません");
  }
  return value;
}

async function waitForTerrainRetry(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  abortIfRequested(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError("地形取得を中止しました"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      setTimeout(() => signal.removeEventListener("abort", onAbort), milliseconds);
    }
  });
  abortIfRequested(signal);
}

function waitForWorldTerrainOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message: string
): Promise<T> {
  abortIfRequested(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createAbortError("地形取得を中止しました")));
    const timeout = setTimeout(
      () => finish(() => reject(createTimeoutError(message))),
      WORLD_TERRAIN_OPERATION_TIMEOUT_MS
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function getWorldTerrainProviderWithRecovery(
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof createWorldTerrainAsync>>> {
  for (let attempt = 0; attempt < WORLD_TERRAIN_MAX_ATTEMPTS; attempt += 1) {
    abortIfRequested(signal);
    try {
      terrainPromise ??= createWorldTerrainAsync({
        requestVertexNormals: false,
        requestWaterMask: false,
      });
      return await waitForWorldTerrainOperation(
        terrainPromise,
        signal,
        "World Terrain providerの取得がタイムアウトしました"
      );
    } catch (error) {
      // reject済みPromiseを保持すると以降の全候補が永久に同じ失敗になるため破棄する。
      terrainPromise = null;
      if (isAbortError(error) || signal?.aborted) throw error;
      if (attempt >= WORLD_TERRAIN_MAX_ATTEMPTS - 1) throw error;
      await waitForTerrainRetry(WORLD_TERRAIN_RETRY_DELAYS_MS[attempt] ?? 700, signal);
    }
  }
  throw new Error("World Terrain providerを取得できませんでした");
}

async function sampleWorldTerrainFallbackWithRecovery(
  points: Cartographic[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WORLD_TERRAIN_MAX_ATTEMPTS; attempt += 1) {
    abortIfRequested(signal);
    try {
      const provider = await getWorldTerrainProviderWithRecovery(signal);
      return await waitForWorldTerrainOperation(
        sampleTerrainMostDetailed(provider, points),
        signal,
        "World Terrain標高取得がタイムアウトしました"
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      lastError = error;
      if (attempt >= WORLD_TERRAIN_MAX_ATTEMPTS - 1) break;
      await waitForTerrainRetry(WORLD_TERRAIN_RETRY_DELAYS_MS[attempt] ?? 700, signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("World Terrainの取得に失敗しました");
}

async function sampleTerrainWithGsiPriority(
  points: Cartographic[],
  maximumDetails?: GsiMaximumDetail[],
  signal?: AbortSignal,
  interpolationMode: "los-safe" | "neutral" = "los-safe"
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  const gsiSamples = await fetchGsiElevationsBatched(
    result,
    maximumDetails,
    signal,
    interpolationMode
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
      geoidHeightBySample.set(result[index], geoidHeightMeters);
    } else {
      unresolvedIndexes.push(index);
    }
  }
  if (unresolvedIndexes.length === 0) return result;

  abortIfRequested(signal);

  const fallbackPoints = unresolvedIndexes.map((index) => result[index]);
  // GSIで解決できなかった地点だけWorld Terrainへ回す。最大3回、同じ座標・
  // 同じ最詳細取得を再試行するだけで、低精度データへの置換は行わない。
  const fallback = await sampleWorldTerrainFallbackWithRecovery(fallbackPoints, signal);
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
  distancesMeters: number[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  if (points.length !== distancesMeters.length) {
    throw new Error("地形断面の座標数と距離数が一致しません");
  }
  // 近距離の遮蔽物だけ1m DEMを使い、遠方は必要十分な解像度へ落として通信量を抑える。
  const details = distancesMeters.map((distance) =>
    distance <= 2_000 ? "1m" as const : distance <= 20_000 ? "5m" as const : "10m" as const
  );
  return sampleTerrainCached(points, details, signal);
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
  if (!Number.isFinite(sampled.height)) {
    throw new Error("地形高度を取得できませんでした");
  }
  const ellipsoidalHeight = sampled.height;
  const baseHeightSource: GroundPoint["heightSource"] =
    (terrainDataSource(sampled) === "CESIUM_WORLD_TERRAIN" ? "terrain" : "dem") as GroundPoint["heightSource"];
  let geoidHeightMeters: number;
  let orthometricHeight: number;
  let heightSource = baseHeightSource;
  try {
    geoidHeightMeters = await fetchGsiGeoidHeight(sampled);
    orthometricHeight = ellipsoidalHeight - geoidHeightMeters;
  } catch (error) {
    // ジオイド高は標高（orthometric）表示の精緻化にのみ使う値であり、
    // 地形の位置・高さそのもの（ellipsoidalHeight）は既に取得できている。
    // ジオイドAPIが再試行しても失敗する場合に処理全体を止めてしまわず、
    // 楕円体高をそのまま標高として扱う既存のフォールバック規約
    // （heightSource: "legacy"）で処理を完了させる（0m代替等は行わない）。
    console.warn(`${label}のジオイド高を取得できなかったため、楕円体高を暫定の標高として使用します`, error);
    geoidHeightMeters = 0;
    orthometricHeight = ellipsoidalHeight;
    heightSource = "legacy";
  }
  return {
    latitude: CesiumMath.toDegrees(sampled.latitude),
    longitude: CesiumMath.toDegrees(sampled.longitude),
    height: ellipsoidalHeight,
    ellipsoidalHeightMeters: ellipsoidalHeight,
    orthometricHeightMeters: orthometricHeight,
    geoidHeightMeters,
    heightSource,
    label,
  };
}
