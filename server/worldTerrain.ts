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
export async function sampleServerWorldTerrain(
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetails?: Array<GsiMaximumDetail | undefined>
): Promise<Cartographic[]> {
  if (points.length === 0) return [];
  abortIfRequested(signal);
  const result = points.map((point) => Cartographic.clone(point));
  let gsiSamples: Awaited<ReturnType<typeof lookupGsiElevations>>;
  try {
    gsiSamples = await lookupGsiElevations(result.map((point, index) => ({
      latitude: CesiumMath.toDegrees(point.latitude),
      longitude: CesiumMath.toDegrees(point.longitude),
      maximumDetail: maximumDetails?.[index],
    })), signal);
  } catch {
    return fallbackToWorldTerrain(result, signal);
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
        CesiumMath.toDegrees(midpoint.longitude),
        signal
      );
    } catch {
      // 高さ基準を混在させないため、ジオイド未取得時は全点をWorld Terrainへ揃える。
      geoidHeightMeters = null;
    }
  }

  const unresolvedIndexes: number[] = [];
  for (let index = 0; index < result.length; index += 1) {
    const sample = gsiSamples[index];
    if (
      sample?.source && Number.isFinite(sample.heightMeters) &&
      geoidHeightMeters !== null
    ) {
      result[index].height = Number(sample.heightMeters) + geoidHeightMeters;
    } else {
      unresolvedIndexes.push(index);
    }
  }
  if (unresolvedIndexes.length === 0) return result;

  const fallback = await fallbackToWorldTerrain(
    unresolvedIndexes.map((index) => result[index]),
    signal
  );
  fallback.forEach((sample, fallbackIndex) => {
    result[unresolvedIndexes[fallbackIndex]] = sample;
  });
  return result;
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
