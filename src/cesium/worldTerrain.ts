import { anySignal } from "../network/abortSignals";
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
import { fetchGsiElevationSamples, type GsiElevationRequestPurpose } from "./gsiElevationClient";
import { prefetchGsiDeviceTilesForSamples, resolveGsiSamplesFromDeviceTiles, resolveGsiSamplesWithDirectTiles } from "./gsiDemTileCache";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { shareInFlightRequest } from "../network/sharedRequests";
import { AbortableSemaphore, CancellableRequestPool, withAbortableTimeout } from "../utils/abortableSemaphore";

let terrainPromise: ReturnType<typeof createWorldTerrainAsync> | null = null;
const terrainSourceBySample = new WeakMap<Cartographic, TerrainDataSource>();
const geoidHeightBySample = new WeakMap<Cartographic, number>();
// GSI API自体は正常応答したが、全DEMソースで標高値が無かった地点。
// 日本国内では海面等の「DEM非収載水面」を0mとして扱うための印。
const authoritativeGsiNoDataBySample = new WeakSet<Cartographic>();
let gsiUnavailableUntil = 0;
let geoidUnavailableUntil = 0;
let geoidWarningLoggedUntil = 0;
// The server can make three 8-second attempts separated by rate-limit waits.
// Start this deadline after obtaining a client slot, never while queued.
const GEOID_FETCH_TIMEOUT_MS = 40_000;
const WORLD_TERRAIN_MAX_ATTEMPTS = 3;
const WORLD_TERRAIN_RETRY_DELAYS_MS = [250, 700] as const;
// Cesiumのprovider生成/sampleTerrainMostDetailedにはAbortSignalも標準の
// タイムアウトもない。GSIフォールバック時に1要求が永久待ちにならないよう、
// 各試行の「待機」だけを制限し、同じ最詳細データ・同じ座標で再試行する。
const WORLD_TERRAIN_OPERATION_TIMEOUT_MS = 30_000;
const geoidHeightCache = new Map<string, number>();
const geoidRequests = new CancellableRequestPool<number>();
const GEOID_MEMORY_CACHE_MAX_ENTRIES = 4_096;
const GEOID_CACHE_DB = "ksg-world-photo-planner-geoid-v1";
const GEOID_CACHE_STORE = "geoid";
const GEOID_CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
// 2026-09-10修正（実機報告：容量は小さいのになぜ遅いのか）: ジオイド高は
// 数km規模でしかほぼ変化しない滑らかな量で、国土地理院自身の公式ジオイド
// モデル（GSIGEO2011）もこれと同程度（約1〜2km）の格子間隔で提供されて
// いる。つまり、これより細かく区切って個別に問い合わせても、元データ自体
// がその解像度を持っていないため精度上の利益はほぼ無く、単に不安定な
// レガシーCGIへの往復回数を無駄に増やしていただけだった。以前の約1.1km
// 格子（GEOID_REGION_DECIMALS=2）から、公式モデルの解像度に見合った
// 約2.8km格子へ広げ、必要な往復回数を約1/6に減らす（格子面積は一辺の
// 2乗で効くため、1.1km→2.8kmで約(2.8/1.1)^2≈6.5倍粗くなる）。
const GEOID_REGION_GRID_DEGREES = 0.025;

function roundToGeoidGrid(degrees: number): number {
  return Math.round(degrees / GEOID_REGION_GRID_DEGREES) * GEOID_REGION_GRID_DEGREES;
}
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
  Map<string, PendingGsiRequest[]>
>();

function pendingGsiRequestKey(
  interpolationMode: "los-safe" | "neutral",
  purpose: GsiElevationRequestPurpose
): string {
  return `${interpolationMode}:${purpose}`;
}

// 同じ被写体周辺を再検索した際にDEM通信を繰り返さない。
// 約1m単位（緯度経度5桁）でメモリとIndexedDBへ保存する。
const TERRAIN_CACHE_DB = "ksg-world-photo-planner-terrain-v3";
const TERRAIN_CACHE_STORE = "terrain";
const TERRAIN_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
type TerrainCachedHeight = { height: number; geoidHeightMeters?: number; source?: TerrainDataSource };
type TerrainSamplingOptions = {
  allowWorldTerrainFallback?: boolean;
  onGeoidProgress?: (completed: number, total: number) => void;
};
const terrainHeightMemoryCache = new Map<string, TerrainCachedHeight>();
const TERRAIN_MEMORY_CACHE_MAX_ENTRIES = 32_768;

type TerrainCacheRecord = {
  key: string;
  height: number;
  geoidHeightMeters?: number;
  source?: TerrainDataSource;
  // v2（2026-10-10）: 楕円体高への変換に、格子の代表値ではなく地点ごとのジオイド高を使う。
  // v1で保存した値（代表値で変換）は読み込まない。
  datum: "ellipsoidal-v2";
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
            record.datum === "ellipsoidal-v2" &&
            Date.now() - record.updatedAt <= TERRAIN_CACHE_MAX_AGE_MS &&
            Number.isFinite(record.height)
          ) {
            const cached: TerrainCachedHeight = {
              height: record.height,
              source: record.source,
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
        source: terrainDataSource(point),
        geoidHeightMeters: geoidHeightBySample.get(point),
        datum: "ellipsoidal-v2" as const,
        updatedAt: Date.now(),
      }]
    : []);
  records.forEach((record) => writeMemoryCache(
    terrainHeightMemoryCache,
    record.key,
    {
      height: record.height,
      source: record.source,
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
  interpolationMode: "los-safe" | "neutral" = "los-safe",
  options: TerrainSamplingOptions = {}
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  const cachedHeights = await readTerrainCache(points, maximumDetails, interpolationMode);
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  const missingIndexes: number[] = [];
  cachedHeights.forEach((cached, index) => {
    // Legacy records have no provenance. They remain usable for normal searches,
    // but cannot establish that an explicit high-precision download succeeded.
    if (cached === null || (options.allowWorldTerrainFallback === false &&
      (!cached.source || cached.source === "CESIUM_WORLD_TERRAIN" || !Number.isFinite(cached.geoidHeightMeters)))) {
      missingIndexes.push(index);
      return;
    }
    result[index].height = cached.height;
    if (cached.source) terrainSourceBySample.set(result[index], cached.source);
    if (Number.isFinite(cached.geoidHeightMeters)) {
      geoidHeightBySample.set(result[index], cached.geoidHeightMeters as number);
    }
  });
  if (options.allowWorldTerrainFallback === false) {
    const warmPoints = points.flatMap((point, index) => missingIndexes.includes(index) ? [] : [{
      latitude: CesiumMath.toDegrees(point.latitude), longitude: CesiumMath.toDegrees(point.longitude),
      maximumDetail: maximumDetails?.[index], interpolationMode,
    }]);
    const warmSamples: GsiElevationApiSample[] = cachedHeights.flatMap((cached, index) => {
      if (!cached || missingIndexes.includes(index)) return [];
      const source = Object.entries(GSI_SOURCE_NAMES).find(([, name]) => name === cached.source)?.[0] as
        Exclude<GsiElevationApiSample["source"], null> | undefined;
      return [{ source: source ?? null, heightMeters: source ? cached.height - cached.geoidHeightMeters! : null }];
    });
    // A prior failed tile download must be retryable even when the authoritative
    // point-height cache is warm. Heights, coordinates and source order are kept.
    prefetchGsiDeviceTilesForSamples(warmPoints, warmSamples);
  }
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
    const localGeoidByIndex = await fetchGeoidHeightsForPoints(
      missingPoints,
      localResolvedIndexes,
      signal,
      options
    );
    abortIfRequested(signal);

    const networkLocalIndexes: number[] = [];
    localSamples.forEach((sample, localIndex) => {
      if (sample === null || sample.heightMeters === null) {
        networkLocalIndexes.push(localIndex);
        return;
      }
      const geoidHeightMeters = localGeoidByIndex.get(localIndex);
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
        interpolationMode,
        options
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
  interpolationMode: "los-safe" | "neutral" = "los-safe",
  purpose: GsiElevationRequestPurpose = "bulk-download"
): Promise<GsiElevationApiSample[]> {
  const clientPoints = points.map((point, index) => ({
    latitude: CesiumMath.toDegrees(point.latitude),
    longitude: CesiumMath.toDegrees(point.longitude),
    maximumDetail: maximumDetails?.[index],
    interpolationMode,
  }));
  const samples: Array<GsiElevationApiSample | null> = points.map(() => null);

  // 2026-09-30: 取得先の優先順位（全経路共通）
  //   1. 端末内（ダウンロード済みデータ・過去に取得したタイル）… 通常の呼び出し元
  //      sampleTerrainCached() で解決済み。ここに来るのは端末に無い地点だけ。
  //      （Googleタイルモードの最高精度 sampleWorldTerrainHighestPrecision だけは
  //      従来どおり端末キャッシュを通さず、R2/Eドライブの最詳細DEMを直接求める。）
  //   2. R2 → 3. Eドライブ → 4. 国土地理院 … Pages API（サーバー側で解決）
  //   5. 国土地理院への端末からの直接取得 … サーバーが応答しない・取得できなかった地点だけ
  //   6. World Terrain（許可された経路のみ）
  async function resolveDirect(indexes: number[]): Promise<void> {
    if (indexes.length === 0) return;
    let direct: Array<GsiElevationApiSample | null>;
    try {
      direct = await resolveGsiSamplesWithDirectTiles(indexes.map((index) => clientPoints[index]), signal);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      console.warn("国土地理院DEMの直接取得に失敗しました", error);
      return;
    }
    direct.forEach((sample, localIndex) => {
      if (sample === null) return;
      const index = indexes[localIndex];
      samples[index] = sample;
      if (sample.source === null && sample.heightMeters === null) {
        authoritativeGsiNoDataBySample.add(points[index]);
      }
    });
  }

  // Pages Functions経路（サーバー側で R2 → Eドライブ → 国土地理院）。
  async function resolveViaServer(indexes: number[]): Promise<{ failed: number[]; lastError: unknown }> {
    if (indexes.length === 0) return { failed: [], lastError: null };
    if (Date.now() < gsiUnavailableUntil) return { failed: indexes, lastError: new Error("GSI API一時停止中") };
    try {
      const subset = indexes.map((index) => clientPoints[index]);
      const result = await fetchGsiElevationSamples(subset, signal, fetch, purpose);
      // 通信失敗と「APIは成功したがDEM値が無い」を混同しない（点単位）。
      const failedIndexSet = new Set(result.failedIndexes);
      result.samples.forEach((sample, localIndex) => {
        if (failedIndexSet.has(localIndex)) return;
        const index = indexes[localIndex];
        samples[index] = sample;
        if (sample.source === null && sample.heightMeters === null) {
          authoritativeGsiNoDataBySample.add(points[index]);
        }
      });
      const succeededPoints = subset.filter((_, localIndex) => !failedIndexSet.has(localIndex));
      const succeededSamples = result.samples.filter((_, localIndex) => !failedIndexSet.has(localIndex));
      // Warm decoded tiles only after the authoritative API result is available.
      prefetchGsiDeviceTilesForSamples(succeededPoints, succeededSamples);
      if (result.failedPointCount === subset.length && subset.length > 0) {
        gsiUnavailableUntil = Date.now() + 15_000;
      }
      return {
        failed: result.failedIndexes.map((localIndex) => indexes[localIndex]),
        lastError: result.lastError,
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      gsiUnavailableUntil = Date.now() + 15_000;
      return { failed: indexes, lastError: error };
    }
  }

  const allIndexes = points.map((_, index) => index);
  const server = await resolveViaServer(allIndexes);
  const lastError = server.lastError;
  await resolveDirect(server.failed);

  const unresolvedCount = samples.filter((sample) => sample === null).length;
  if (unresolvedCount > 0) {
    const allFailed = unresolvedCount === points.length;
    console.warn(
      `国土地理院DEMの${unresolvedCount}地点を取得できないためWorld Terrainを使用します`,
      lastError
    );
    publishUserNotice({
      key: "gsi-dem-fallback",
      tone: "warning",
      message: allFailed
        ? "国土地理院の詳細地形データを取得できませんでした。精度の低い別の地形データで求めた地点は、三脚候補として確定しません。通信状態を確認して、もう一度お試しください。"
        : `国土地理院の詳細地形データを一部（${unresolvedCount}地点）取得できませんでした。その地点は精度の低い別の地形データで補っているため、三脚候補として確定しません。`,
    });
  }
  return samples.map((sample) => sample ?? { heightMeters: null, source: null });
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

async function flushGsiRequests(
  signal: AbortSignal | undefined,
  interpolationMode: "los-safe" | "neutral",
  purpose: GsiElevationRequestPurpose
): Promise<void> {
  const bySignal = pendingGsiRequests.get(signal);
  const groupKey = pendingGsiRequestKey(interpolationMode, purpose);
  const requests = bySignal?.get(groupKey) ?? [];
  if (bySignal) {
    bySignal.delete(groupKey);
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
      interpolationMode,
      purpose
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
  interpolationMode: "los-safe" | "neutral" = "los-safe",
  purpose: GsiElevationRequestPurpose = "bulk-download"
): Promise<GsiElevationApiSample[]> {
  return new Promise((resolve, reject) => {
    let bySignal = pendingGsiRequests.get(signal);
    if (!bySignal) {
      bySignal = new Map();
      pendingGsiRequests.set(signal, bySignal);
    }
    const groupKey = pendingGsiRequestKey(interpolationMode, purpose);
    const requests = bySignal.get(groupKey);
    const request = { points, maximumDetails, resolve, reject };
    if (requests) {
      requests.push(request);
      return;
    }
    bySignal.set(groupKey, [request]);
    // 同一検索フレームかつ同じ用途の候補だけをまとめる。interactiveと
    // bulk-downloadを混ぜるとprivate gateway利用方針が変わるため分離する。
    queueMicrotask(() => void flushGsiRequests(signal, interpolationMode, purpose));
  });
}

function geoidRegionKey(point: Cartographic): string {
  const latitude = roundToGeoidGrid(CesiumMath.toDegrees(point.latitude));
  const longitude = roundToGeoidGrid(CesiumMath.toDegrees(point.longitude));
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

let geoidCacheDatabasePromise: Promise<KsgIdbDatabase | null> | null = null;

function openGeoidCache(): Promise<KsgIdbDatabase | null> {
  const indexedDb = getIndexedDbFactory();
  if (!indexedDb) return Promise.resolve(null);
  // 同じ計算中に地域ごとにDBをopen/closeすると、IndexedDBの接続確立イベントが
  // メインスレッドへ大量に戻る。DB接続だけを共有し、保存値・キー・有効期限は
  // 従来のまま維持するため、地形/ジオイド精度には影響しない。
  geoidCacheDatabasePromise ??= boundedTerrainCacheOperation(new Promise<KsgIdbDatabase | null>((resolve) => {
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
  }), null).then((database) => {
    if (!database) geoidCacheDatabasePromise = null;
    return database;
  });
  return geoidCacheDatabasePromise;
}

async function readGeoidPersistentCache(key: string): Promise<number | null> {
  const database = await openGeoidCache();
  if (!database) return null;
  const value = await boundedTerrainCacheOperation(new Promise<number | null>((resolve) => {
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
  }), null);
  return value;
}

async function writeGeoidPersistentCache(key: string, height: number): Promise<void> {
  const database = await openGeoidCache();
  if (!database) return;
  await boundedTerrainCacheOperation(new Promise<void>((resolve) => {
    const transaction = database.transaction(GEOID_CACHE_STORE, "readwrite");
    transaction.objectStore(GEOID_CACHE_STORE).put({ key, height, updatedAt: Date.now() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  }), undefined);
}

// GSI rate-limits the upstream CGI. Serialize cache misses so its queue
// cannot outgrow a request deadline. Cancellation removes queued requests.
const MAX_CONCURRENT_GEOID_REQUESTS = 1;
const geoidRequestSlots = new AbortableSemaphore(MAX_CONCURRENT_GEOID_REQUESTS);
// Candidate refinement must still reach the server's point cache within its
// existing deadline, even while regional download requests are waiting.
const pointGeoidRequestSlots = new AbortableSemaphore(4);
const GEOID_UPSTREAM_INTERVAL_MS = 3_500;
let lastUncachedGeoidRequestAt = 0;

// 2026-09-30: 国内のジオイド高は、サーバー（/api/gsi-geoid）が行っているのと
// 同じ同梱JPGEO2024（server/jpgeo2024Local.ts）を端末で直接引く。サーバーは
// 国内座標ではこの関数を呼ぶだけでCGIへ行かないため、値は完全に同一。
// モジュール（約2.8MB）は初回に一度だけ遅延読込し、読めない場合だけ従来の
// API経路へ戻る。
type LocalJpgeoModule = typeof import("../../server/jpgeo2024Local.ts");
let localJpgeoModulePromise: Promise<LocalJpgeoModule | null> | null = null;
function loadLocalJpgeo(): Promise<LocalJpgeoModule | null> {
  localJpgeoModulePromise ??= import("../../server/jpgeo2024Local.ts").catch((error: unknown) => {
    console.warn("端末内JPGEO2024を読み込めないためジオイドAPIを使用します", error);
    localJpgeoModulePromise = null;
    return null;
  });
  return localJpgeoModulePromise;
}

let localGeoidEnabled = true;
/** テスト専用: ジオイドAPIのキュー・取消挙動を検証する回帰テストで端末内計算を止める。 */
export function __setLocalGeoidEnabledForTesting(enabled: boolean): void {
  localGeoidEnabled = enabled;
}

/** server/gsiGeoid.ts lookupGsiGeoidHeight と同じ座標丸め規則で端末内計算する。 */
async function localGeoidHeight(latitude: number, longitude: number, pointSpecific: boolean): Promise<number | null> {
  if (!localGeoidEnabled) return null;
  const module = await loadLocalJpgeo();
  if (!module) return null;
  const queryLatitude = pointSpecific ? latitude : Number(latitude.toFixed(2));
  const queryLongitude = pointSpecific ? longitude : Number(longitude.toFixed(2));
  try {
    const height = module.lookupLocalJpgeo2024Height(queryLatitude, queryLongitude);
    return typeof height === "number" && Number.isFinite(height) ? height : null;
  } catch (error) {
    console.warn("端末内JPGEO2024の計算に失敗しました", error);
    return null;
  }
}

async function fetchGsiGeoidHeightOnce(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  pointSpecific = false,
  timeoutMs = GEOID_FETCH_TIMEOUT_MS
): Promise<number> {
  const local = await localGeoidHeight(latitude, longitude, pointSpecific);
  if (local !== null) return local;
  // 国土地理院ジオイドCGIは応答が不安定なことがあり、タイムアウトが
  // 無いとハングして無期限に待ち続けてしまう（実際に発生していた
  // 「数分待っても描画されない」不具合の主因の1つ）。
  const release = await (pointSpecific ? pointGeoidRequestSlots : geoidRequestSlots).acquire(signal);
  try {
    return await withAbortableTimeout(async (requestSignal) => {
    // Separate Cloudflare isolates cannot share the server's in-memory limiter.
    // Pace regional downloads as well, including after a server error. Point
    // refinement retains its previous server-side limiter and cache-first path.
    if (!pointSpecific) {
      await waitForGeoidTime(lastUncachedGeoidRequestAt + GEOID_UPSTREAM_INTERVAL_MS, requestSignal);
      lastUncachedGeoidRequestAt = Date.now();
    }
    const response = await diagnosticFetch("gsi-geoid",
      `/api/gsi-geoid?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}${pointSpecific ? "&precision=point" : ""}`,
      {
        headers: { Accept: "application/json" },
        signal: requestSignal,
      }
    );
    const data = await response.json() as {
      geoidHeightMeters?: unknown;
      error?: unknown;
      cache?: unknown;
    };
    // A bundled JPGEO2024 result, like an R2 hit, never reaches GSI's CGI.
    // Clear the legacy upstream pacing marker immediately so regional download
    // requests do not retain the old 3.5-second CGI interval on the local path.
    if (!pointSpecific && (data.cache === "hit" || data.cache === "local")) {
      lastUncachedGeoidRequestAt = 0;
    }
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
    }, timeoutMs, "国土地理院ジオイドAPIがタイムアウトしました", signal);
  } finally {
    release();
  }
}

// 2026-09-01追記: 従来はgeoidUnavailableUntil中のジオイド取得を即座に
// 失敗させていた。しかし三脚候補の精密化（refineWithManualEquivalentProjection）
// はジオイド取得の失敗をそのまま候補全体の棄却に使っており、無関係な
// 地点・無関係な検索で先に起きた一時的なAPI不調（8秒間のブレーカー）が、
// 既に得られている粗い解（seed）ごと候補を消してしまう実害が実機診断で
// 確認された。ブレーカーは「即失敗」ではなく「解除まで待ってから通常どおり
// 試す」方式にし、瞬間的な不調からの回復を優先する。ブレーカーの残り時間は
// 設計上常に8秒以内のため、待ち時間の上限も自明に抑えられる。
async function waitForGeoidTime(deadline: number, signal?: AbortSignal): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, remainingMs);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForGeoidBreakerToClear(signal?: AbortSignal): Promise<void> {
  return waitForGeoidTime(geoidUnavailableUntil, signal);
}

// IndexedDB operations are independently bounded. The regional HTTP
// deadline starts after a queue slot is available, allowing healthy long queues.
export async function fetchGsiGeoidHeight(
  point: Cartographic,
  signal?: AbortSignal
): Promise<number> {
  abortIfRequested(signal);
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  // 2026-10-10（精度最優先）: 端末内のJPGEO2024で求められる地点は、約2.8km格子の
  // 代表値ではなく、その地点自身の値を返す（通信なし）。
  const pointSpecific = await localGeoidHeight(latitude, longitude, true);
  abortIfRequested(signal);
  if (pointSpecific !== null) return pointSpecific;
  const key = geoidRegionKey(point);
  const cached = readMemoryCache(geoidHeightCache, key);
  if (cached !== undefined) return cached;

  return geoidRequests.request(key, signal, async (requestSignal) => {
    try {
      await waitForGeoidBreakerToClear(requestSignal);
      const persistent = await readGeoidPersistentCache(key);
      abortIfRequested(requestSignal);
      if (persistent !== null) {
        writeMemoryCache(geoidHeightCache, key, persistent, GEOID_MEMORY_CACHE_MAX_ENTRIES);
        return persistent;
      }

      // The server already retries. Duplicating that retry here amplified its queue.
      const height = await fetchGsiGeoidHeightOnce(latitude, longitude, requestSignal);
      void writeGeoidPersistentCache(key, height).catch(() => undefined);
      writeMemoryCache(geoidHeightCache, key, height, GEOID_MEMORY_CACHE_MAX_ENTRIES);
      return height;
    } catch (error) {
    if (!requestSignal.aborted && !isAbortError(error)) {
      // 1回の失敗で長時間ブロックすると、それだけで「頻繁にエラーが出る」体感を
      // 生んでしまうため、短い間隔にとどめる（連続失敗時の最低限の配慮のみ）。
      geoidUnavailableUntil = Date.now() + 8_000;
    }
    throw error;
    }
  });
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
  abortIfRequested(signal);
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  const key = `point:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const cached = readMemoryCache(geoidHeightCache, key);
  if (cached !== undefined) return cached;

  return withAbortableTimeout(
    (operationSignal) => geoidRequests.request(key, operationSignal, async (requestSignal) => {
      await waitForGeoidBreakerToClear(requestSignal);
      const persistent = await readGeoidPersistentCache(key);
      abortIfRequested(requestSignal);
      if (persistent !== null) {
        writeMemoryCache(geoidHeightCache, key, persistent, GEOID_MEMORY_CACHE_MAX_ENTRIES);
        return persistent;
      }
      const height = await fetchGsiGeoidHeightOnce(latitude, longitude, requestSignal, true);
      void writeGeoidPersistentCache(key, height).catch(() => undefined);
      writeMemoryCache(geoidHeightCache, key, height, GEOID_MEMORY_CACHE_MAX_ENTRIES);
      return height;
    }),
    timeoutMs,
    "地点別ジオイドAPIがタイムアウトしました（IndexedDB待ち含む全体）",
    signal
  ).catch((error: unknown) => {
    if (!signal?.aborted && !isAbortError(error) && (error as Error)?.name !== "TimeoutError") geoidUnavailableUntil = Date.now() + 8_000;
    throw error;
  });
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

/**
 * 2026-10-10（精度最優先）: 地点ごとのジオイド高（h = H + N の N）。
 *
 * 以前は約2.8km四方（0.025度格子）ごとに代表1点のジオイド高を使い回していた。
 * 往復回数を減らすための措置だったが、国内のジオイド高は端末に同梱したJPGEO2024で
 * 通信なしに求められるようになったため、代表値にする理由が無くなっていた。
 * 代表値のままだと、被写体と三脚候補が別の格子に入った時に高さの基準へ段差が生じ、
 * 視線の仰角（合否の基準は0.002度。1.7km先で約6cm）へそのまま乗る。
 * 各地点の緯度経度そのものでJPGEO2024を引く。同梱モデルの範囲外など、端末内で
 * 求められない地点だけ従来の代表値を使う。
 */
async function fetchGeoidHeightsForPoints(
  points: Cartographic[],
  eligibleIndexes: number[],
  signal?: AbortSignal,
  options: TerrainSamplingOptions = {}
): Promise<Map<number, number>> {
  const heights = new Map<number, number>();
  const regionalIndexes: number[] = [];
  await Promise.all(eligibleIndexes.map(async (index) => {
    const point = points[index];
    const local = await localGeoidHeight(
      CesiumMath.toDegrees(point.latitude),
      CesiumMath.toDegrees(point.longitude),
      true
    );
    if (local !== null) heights.set(index, local);
    else regionalIndexes.push(index);
  }));
  abortIfRequested(signal);
  if (regionalIndexes.length === 0) {
    options.onGeoidProgress?.(1, 1);
    return heights;
  }
  const regional = await fetchRegionalGeoidHeights(points, regionalIndexes, signal, options);
  for (const index of regionalIndexes) {
    const height = regional.get(geoidRegionKey(points[index]));
    if (typeof height === "number" && Number.isFinite(height)) heights.set(index, height);
  }
  return heights;
}

async function fetchRegionalGeoidHeights(
  points: Cartographic[],
  eligibleIndexes: number[],
  signal?: AbortSignal,
  options: TerrainSamplingOptions = {}
): Promise<Map<string, number>> {
  const representativeByRegion = new Map<string, Cartographic>();
  for (const index of eligibleIndexes) {
    const point = points[index];
    const key = geoidRegionKey(point);
    if (!representativeByRegion.has(key)) representativeByRegion.set(key, point);
  }

  const heights = new Map<string, number>();
  const controller = new AbortController();
  const requestSignal = signal ? anySignal([signal, controller.signal]) : controller.signal;
  let completed = 0;
  options.onGeoidProgress?.(0, representativeByRegion.size);
  await Promise.all(Array.from(representativeByRegion.entries()).map(async ([key, point]) => {
    try {
      const height = await fetchGsiGeoidHeight(point, requestSignal);
      heights.set(key, height);
    } catch (error) {
      if (requestSignal.aborted || isAbortError(error)) throw error;
      if (options.allowWorldTerrainFallback === false) {
        controller.abort(error);
        throw error;
      }
      if (Date.now() >= geoidWarningLoggedUntil) {
        geoidWarningLoggedUntil = Date.now() + 60_000;
        console.warn("一部地域のジオイド高を取得できないため該当地域はWorld Terrainを使用します", error);
      }
    } finally {
      completed += 1;
      options.onGeoidProgress?.(completed, representativeByRegion.size);
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
  maximumDetail?: GsiMaximumDetail,
  options: TerrainSamplingOptions = {}
): Promise<Cartographic[]> {
  return sampleTerrainCached(
    points,
    maximumDetail
      ? points.map(() => maximumDetail)
      : undefined,
    signal,
    "neutral",
    options
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
      const localValues = await Promise.all(
        geoidPoints.map((point) => localGeoidHeight(point.latitude, point.longitude, true))
      );
      if (localValues.every((value): value is number => value !== null)) return localValues;
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
  interpolationMode: "los-safe" | "neutral" = "los-safe",
  options: TerrainSamplingOptions = {}
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  // ライブ三脚探索・通常操作はpublic GSI/R2の正確な経路を直接使い、
  // private E-drive gatewayの最大12秒待ちを挟まない。明示的な高精度
  // 一括ダウンロード（World Terrain fallback禁止）だけ従来どおりgatewayを使う。
  // DEMソース優先順位・座標・補間・NoData判定は同じまま、待ち経路だけを分離する。
  const gsiPurpose: GsiElevationRequestPurpose = options.allowWorldTerrainFallback === false
    ? "bulk-download"
    : "interactive";
  const gsiSamples = await fetchGsiElevationsBatched(
    result,
    maximumDetails,
    signal,
    interpolationMode,
    gsiPurpose
  );
  const gsiEligibleIndexes = gsiSamples.map((sample, index) =>
    (
      sample.source !== null &&
      typeof sample.heightMeters === "number" &&
      Number.isFinite(sample.heightMeters)
    ) || authoritativeGsiNoDataBySample.has(result[index])
      ? index
      : -1
  ).filter((index) => index >= 0);
  const geoidHeightByIndex = await fetchGeoidHeightsForPoints(
    result,
    gsiEligibleIndexes,
    signal,
    options
  );

  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const gsi = gsiSamples[index];
    const geoidHeightMeters = geoidHeightByIndex.get(index);
    if (
      authoritativeGsiNoDataBySample.has(result[index]) &&
      typeof geoidHeightMeters === "number"
    ) {
      // 海面等のGSI DEM非収載水面は平均海面基準H=0mとして扱う。
      // Cesium内部は楕円体高hなので h = H + N = N とする。
      result[index].height = geoidHeightMeters;
      terrainSourceBySample.set(result[index], "GSI_WATER_ZERO");
      geoidHeightBySample.set(result[index], geoidHeightMeters);
    } else if (
      gsi &&
      gsi.source &&
      typeof gsi.heightMeters === "number" &&
      Number.isFinite(gsi.heightMeters) &&
      typeof geoidHeightMeters === "number"
    ) {
      // GSI標高（平均海面基準）へその地点のジオイド高を加え、楕円体高へ統一する。
      result[index].height = gsi.heightMeters + geoidHeightMeters;
      terrainSourceBySample.set(result[index], GSI_SOURCE_NAMES[gsi.source]);
      geoidHeightBySample.set(result[index], geoidHeightMeters);
    } else {
      unresolvedIndexes.push(index);
    }
  }
  if (unresolvedIndexes.length === 0) return result;

  abortIfRequested(signal);

  if (options.allowWorldTerrainFallback === false) {
    const missingGeoid = unresolvedIndexes.filter((index) =>
      gsiEligibleIndexes.includes(index) && !geoidHeightByIndex.has(index)
    ).length;
    throw new Error(`高精度地形を取得できません（DEM未取得 ${unresolvedIndexes.length - missingGeoid}点・ジオイド高未取得 ${missingGeoid}点 / ${result.length}点）。通信状態を確認して再実行してください`);
  }

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

/**
 * 国土地理院のデータを取得できず、代替の地形データ（World Terrain）で高さを決めた
 * 標本か。出典が記録されていない標本（テスト用の地形など）は対象にしない。
 */
export function isLowPrecisionFallbackTerrainSample(sample: Cartographic): boolean {
  return terrainSourceBySample.get(sample) === "CESIUM_WORLD_TERRAIN";
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
