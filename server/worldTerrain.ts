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
    return Promise.reject(new DOMException("地形取得を中止しました", "AbortError"));
  }
  return new Promise<Cartographic>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("地形取得を中止しました", "AbortError"));
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
  if (signal?.aborted) throw new DOMException("地形取得を中止しました", "AbortError");
}

async function fallbackToWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  abortIfRequested(signal);
  const token = (
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

  const firstGsiIndex = gsiSamples.findIndex((sample) =>
    sample.source !== null && typeof sample.heightMeters === "number"
  );
  let geoidHeightMeters: number | null = null;
  if (firstGsiIndex >= 0) {
    const midpoint = result[Math.floor(result.length / 2)] ?? result[firstGsiIndex];
    try {
      geoidHeightMeters = await lookupGsiGeoidHeight(
        CesiumMath.toDegrees(midpoint.latitude),
        CesiumMath.toDegrees(midpoint.longitude)
      );
    } catch {
      geoidHeightMeters = null;
    }
  }

  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const sample = gsiSamples[index];
    if (sample?.source && Number.isFinite(sample.heightMeters) && geoidHeightMeters !== null) {
      result[index].height = Number(sample.heightMeters) + geoidHeightMeters;
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
  const missing = new Map<string, {
    point: Cartographic;
    maximumDetail: GsiMaximumDetail | undefined;
    indexes: number[];
  }>();
  const waits: Array<Promise<void>> = [];

  points.forEach((point, index) => {
    const maximumDetail = maximumDetails?.[index];
    const key = terrainSampleKey(point, maximumDetail);
    const cached = terrainSampleCache.get(key);
    if (cached) {
      waits.push(awaitTerrainSample(cached, signal).then((sample) => { output[index] = sample; }));
      return;
    }
    const entry = missing.get(key);
    if (entry) entry.indexes.push(index);
    else missing.set(key, { point: Cartographic.clone(point), maximumDetail, indexes: [index] });
  });

  if (missing.size > 0) {
    const entries = [...missing.entries()];
    const sharedBatch = sampleServerWorldTerrainUncached(
      entries.map(([, entry]) => entry.point),
      entries.map(([, entry]) => entry.maximumDetail)
    );
    entries.forEach(([key, entry], batchIndex) => {
      const promise = rememberTerrainSample(
        key,
        sharedBatch.then((samples) => Cartographic.clone(samples[batchIndex])).catch((error) => {
          terrainSampleCache.delete(key);
          throw error;
        })
      );
      for (const index of entry.indexes) {
        waits.push(awaitTerrainSample(promise, signal).then((sample) => { output[index] = sample; }));
      }
    });
  }

  await Promise.all(waits);
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
