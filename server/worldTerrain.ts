import { createAbortError } from "./runtimeErrors.ts";
import {
  Cartographic,
  createWorldTerrainAsync,
  Ion,
  Math as CesiumMath,
  sampleTerrainMostDetailed,
} from "cesium";

import { lookupGsiElevations } from "./gsiElevation.ts";
import type { GsiElevationRequestPoint } from "./gsiElevation.ts";
import { lookupGsiGeoidHeight } from "./gsiGeoid.ts";
import { serverCesiumIonToken } from "./cloudflareRuntime.ts";

type GsiMaximumDetail = NonNullable<GsiElevationRequestPoint["maximumDetail"]>;

let worldTerrainPromise: ReturnType<typeof createWorldTerrainAsync> | null = null;

const MAX_TERRAIN_SAMPLE_CACHE_ENTRIES = 32_768;
const terrainSampleCache = new Map<string, Promise<Cartographic>>();

function terrainSampleKey(
  point: Cartographic,
  maximumDetail: GsiMaximumDetail | undefined
): string {
  // 同一計算点だけを共有し、座標を近似・間引きしない。
  // radians の十分な桁数を保持することで検索精度へ影響させない。
  return [
    point.latitude.toFixed(12),
    point.longitude.toFixed(12),
    maximumDetail ?? "auto",
  ].join(":");
}

function rememberTerrainSample(
  key: string,
  promise: Promise<Cartographic>
): Promise<Cartographic> {
  terrainSampleCache.set(key, promise);
  if (terrainSampleCache.size > MAX_TERRAIN_SAMPLE_CACHE_ENTRIES) {
    const oldestKey = terrainSampleCache.keys().next().value;
    if (typeof oldestKey === "string") terrainSampleCache.delete(oldestKey);
  }
  return promise;
}

function awaitTerrainSample(
  promise: Promise<Cartographic>,
  signal?: AbortSignal
): Promise<Cartographic> {
  if (!signal) return promise.then((sample) => Cartographic.clone(sample));
  if (signal.aborted) {
    return Promise.reject(createAbortError("地形取得を中止しました"));
  }
  return new Promise<Cartographic>((resolve, reject) => {
    const onAbort = () => reject(createAbortError("地形取得を中止しました"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (sample) => {
        signal.removeEventListener("abort", onAbort);
        resolve(Cartographic.clone(sample));
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError("地形取得を中止しました");
}

async function fallbackToWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  abortIfRequested(signal);
  const token = serverCesiumIonToken() ?? (
    process.env.CESIUM_ION_TOKEN ?? process.env.VITE_CESIUM_ION_TOKEN
  )?.trim();
  if (token) Ion.defaultAccessToken = token;
  worldTerrainPromise ??= createWorldTerrainAsync({
    requestVertexNormals: false,
    requestWaterMask: false,
  });
  const samples = await sampleTerrainMostDetailed(
    await worldTerrainPromise,
    points.map((point) => Cartographic.clone(point))
  );
  abortIfRequested(signal);
  return samples;
}

/** ブラウザー版と同じく、日本はGSI DEMを優先し楕円体高へ統一する。 */
async function sampleServerWorldTerrainUncached(
  points: Cartographic[],
  maximumDetails?: Array<GsiMaximumDetail | undefined>
): Promise<Cartographic[]> {
  const result = points.map((point) => Cartographic.clone(point));
  let gsiSamples: Awaited<ReturnType<typeof lookupGsiElevations>>;
  try {
    gsiSamples = await lookupGsiElevations(result.map((point, index) => ({
      latitude: CesiumMath.toDegrees(point.latitude),
      longitude: CesiumMath.toDegrees(point.longitude),
      maximumDetail: maximumDetails?.[index],
    })));
  } catch {
    return fallbackToWorldTerrain(result);
  }

  // 以前は配列中央1地点のジオイド高Nを全サンプルへ流用していた。
  // H(標高)→h(楕円体高)変換の高さ基準を地点間で混同しないため、
  // 各0.01度地域ごとに代表Nを解決して、その地域内のサンプルだけへ適用する。
  // 最終三脚候補はブラウザー側でさらに地点固有Nへ置換して確定する。
  const geoidByRegion = new Map<string, number>();
  const regionKey = (point: Cartographic) =>
    `${CesiumMath.toDegrees(point.latitude).toFixed(2)},${CesiumMath.toDegrees(point.longitude).toFixed(2)}`;
  const representativeByRegion = new Map<string, Cartographic>();
  for (let index = 0; index < result.length; index += 1) {
    const sample = gsiSamples[index];
    if (sample?.source && Number.isFinite(sample.heightMeters)) {
      const key = regionKey(result[index]);
      if (!representativeByRegion.has(key)) representativeByRegion.set(key, result[index]);
    }
  }
  await Promise.all(Array.from(representativeByRegion.entries()).map(async ([key, point]) => {
    try {
      geoidByRegion.set(key, await lookupGsiGeoidHeight(
        CesiumMath.toDegrees(point.latitude),
        CesiumMath.toDegrees(point.longitude)
      ));
    } catch {
      // その地域だけWorld Terrainへフォールバックする。
    }
  }));

  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const sample = gsiSamples[index];
    const geoidHeightMeters = geoidByRegion.get(regionKey(result[index]));
    if (sample?.source && Number.isFinite(sample.heightMeters) && Number.isFinite(geoidHeightMeters)) {
      result[index].height = Number(sample.heightMeters) + (geoidHeightMeters as number);
    } else {
      unresolvedIndexes.push(index);
    }
  }
  if (unresolvedIndexes.length === 0) return result;

  const fallback = await fallbackToWorldTerrain(
    unresolvedIndexes.map((index) => result[index])
  );
  fallback.forEach((sample, fallbackIndex) => {
    result[unresolvedIndexes[fallbackIndex]] = sample;
  });
  return result;
}

/** ブラウザー版と同じく、日本はGSI DEMを優先し楕円体高へ統一する。 */
export async function sampleServerWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetails?: Array<GsiMaximumDetail | undefined>
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);

  const output = new Array<Cartographic>(points.length);
  const requests = new Map<string, {
    point: Cartographic;
    maximumDetail: GsiMaximumDetail | undefined;
    indexes: number[];
    cached?: Promise<Cartographic>;
  }>();

  // Phase6-2: サンプル1点ごとの Promise<void> と thenクロージャ生成を廃止する。
  // 同一キーを1要求へまとめ、ユニーク地点数分だけ待機してから出力へ展開する。
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const maximumDetail = maximumDetails?.[index];
    const key = terrainSampleKey(point, maximumDetail);
    const existing = requests.get(key);
    if (existing) {
      existing.indexes.push(index);
      continue;
    }
    requests.set(key, {
      point: Cartographic.clone(point),
      maximumDetail,
      indexes: [index],
      cached: terrainSampleCache.get(key),
    });
  }

  const uncachedEntries = [...requests.entries()].filter(([, entry]) => !entry.cached);
  if (uncachedEntries.length > 0) {
    const sharedBatch = sampleServerWorldTerrainUncached(
      uncachedEntries.map(([, entry]) => entry.point),
      uncachedEntries.map(([, entry]) => entry.maximumDetail)
    );
    uncachedEntries.forEach(([key, entry], batchIndex) => {
      entry.cached = rememberTerrainSample(
        key,
        sharedBatch.then((samples) => Cartographic.clone(samples[batchIndex])).catch((error) => {
          terrainSampleCache.delete(key);
          throw error;
        })
      );
    });
  }

  const requestEntries = [...requests.values()];
  const samples = await Promise.all(
    requestEntries.map((entry) => awaitTerrainSample(entry.cached!, signal))
  );
  for (let requestIndex = 0; requestIndex < requestEntries.length; requestIndex += 1) {
    const entry = requestEntries[requestIndex];
    const sample = samples[requestIndex];
    for (const outputIndex of entry.indexes) {
      output[outputIndex] = Cartographic.clone(sample);
    }
  }

  abortIfRequested(signal);
  return output;
}

export async function sampleServerLineOfSightTerrain(
  points: Cartographic[],
  distancesMeters: number[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  if (points.length !== distancesMeters.length) {
    throw new Error("地形断面の座標数と距離数が一致しません");
  }
  const details = distancesMeters.map((distance) =>
    distance <= 2_000 ? "1m" as const :
    distance <= 20_000 ? "5m" as const : "10m" as const
  );
  return sampleServerWorldTerrain(points, signal, details);
}
