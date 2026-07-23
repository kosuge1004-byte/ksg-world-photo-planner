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

let terrainPromise: ReturnType<typeof createWorldTerrainAsync> | null = null;
const terrainSourceBySample = new WeakMap<Cartographic, TerrainDataSource>();
const GSI_BATCH_SIZE = 2_048;
let gsiUnavailableUntil = 0;
let geoidUnavailableUntil = 0;
let geoidWarningLoggedUntil = 0;
const geoidHeightCache = new Map<string, Promise<number>>();
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
  const samples: GsiElevationApiSample[] = [];
  try {
    for (let offset = 0; offset < points.length; offset += GSI_BATCH_SIZE) {
      const batch = points.slice(offset, offset + GSI_BATCH_SIZE);
      const response = await fetch("/api/gsi-elevation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          points: batch.map((point, batchIndex) => ({
            latitude: CesiumMath.toDegrees(point.latitude),
            longitude: CesiumMath.toDegrees(point.longitude),
            maximumDetail: maximumDetails?.[offset + batchIndex],
          })),
        }),
        signal,
      });
      const data = (await response.json()) as {
        samples?: unknown;
        error?: unknown;
      };
      if (!response.ok || !Array.isArray(data.samples)) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `国土地理院標高APIエラー：${response.status}`
        );
      }
      samples.push(...(data.samples as GsiElevationApiSample[]));
    }
    if (samples.length !== points.length) {
      throw new Error("国土地理院標高APIの応答点数が一致しません");
    }
    return samples;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // 一時障害時は連続要求を避け、Cesium World Terrainへ安全にフォールバックする。
    gsiUnavailableUntil = Date.now() + 60_000;
    console.warn("国土地理院DEMを取得できないためWorld Terrainを使用します", error);
    return points.map(() => ({ heightMeters: null, source: null }));
  }
}

async function flushGsiRequests(signal?: AbortSignal): Promise<void> {
  const requests = pendingGsiRequests.get(signal) ?? [];
  pendingGsiRequests.delete(signal);
  if (requests.length === 0) return;
  try {
    abortIfRequested(signal);
    const points = requests.flatMap((request) => request.points);
    const hasMaximumDetails = requests.some((request) => request.maximumDetails);
    const maximumDetails = hasMaximumDetails
      ? requests.flatMap((request) => request.points.map(
          (_, index) => request.maximumDetails?.[index]
        ))
      : undefined;
    const samples = await fetchGsiElevations(points, maximumDetails, signal);
    let offset = 0;
    for (const request of requests) {
      const end = offset + request.points.length;
      request.resolve(samples.slice(offset, end));
      offset = end;
    }
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

async function fetchGsiGeoidHeight(
  point: Cartographic,
  signal?: AbortSignal
): Promise<number> {
  if (Date.now() < geoidUnavailableUntil) {
    throw new Error("国土地理院ジオイドAPIの再試行待ちです");
  }
  const latitude = CesiumMath.toDegrees(point.latitude);
  const longitude = CesiumMath.toDegrees(point.longitude);
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  const cached = geoidHeightCache.get(key);
  if (cached) return cached;
  const request = fetch(
    `/api/gsi-geoid?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
    { headers: { Accept: "application/json" }, signal }
  ).then(async (response) => {
    const data = await response.json() as {
      geoidHeightMeters?: unknown;
      error?: unknown;
    };
    if (!response.ok || typeof data.geoidHeightMeters !== "number") {
      throw new Error(
        typeof data.error === "string" ? data.error : "ジオイド高を取得できません"
      );
    }
    return data.geoidHeightMeters;
  }).catch((error: unknown) => {
    geoidHeightCache.delete(key);
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      geoidUnavailableUntil = Date.now() + 60_000;
    }
    throw error;
  });
  geoidHeightCache.set(key, request);
  return request;
}

export async function sampleWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal
): Promise<Cartographic[]> {
  return sampleTerrainWithGsiPriority(points, undefined, signal);
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
  const hasGsiSample = gsiSamples.some((sample) =>
    sample.source !== null && typeof sample.heightMeters === "number"
  );
  let geoidHeightMeters: number | null = null;
  if (hasGsiSample) {
    try {
      geoidHeightMeters = await fetchGsiGeoidHeight(
        result[Math.floor(result.length / 2)],
        signal
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // 高さ基準を混在させるよりWorld Terrainへ統一した方が三脚計算は安全。
      if (Date.now() >= geoidWarningLoggedUntil) {
        geoidWarningLoggedUntil = Date.now() + 60_000;
        console.warn("ジオイド高を取得できないためGSI標高を採用しません", error);
      }
    }
  }
  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const gsi = gsiSamples[index];
    if (
      gsi &&
      gsi.source &&
      typeof gsi.heightMeters === "number" &&
      Number.isFinite(gsi.heightMeters) &&
      geoidHeightMeters !== null
    ) {
      // GSI標高（平均海面基準）へジオイド高を加え、Cesiumの楕円体高へ統一する。
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
  return sampleTerrainWithGsiPriority(points, details);
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
