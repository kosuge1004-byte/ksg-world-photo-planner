import {
  Cartesian3,
  Cartographic,
} from "cesium";

import type {
  CelestialOcclusion,
  HorizontalCoordinates,
} from "../src/types/celestial.ts";
import { calculateKarneyDestinationPoint } from "../src/geodesy/karneyGeodesic.ts";
import { classifyTerrainOcclusion } from "../src/celestial/terrainOcclusionPolicy.ts";
import { scanAdaptiveTerrainProfile } from "../src/geodesy/adaptiveTerrainProfile.ts";
import type { GroundPoint } from "../src/types/points.ts";
import { sampleServerLineOfSightTerrain } from "./worldTerrain.ts";
import { lookupSurfaceObstructionHorizon } from "./surfaceObstructionLineOfSight.ts";
import { LruPromiseCache } from "./lruPromiseCache.ts";

const TERRAIN_DISTANCE_LIMIT_METERS = 160_000;
const horizonCache = new LruPromiseCache<TerrainHorizon>({
  maxEntries: 4_096,
  ttlMs: 6 * 60 * 60 * 1_000,
});

type TerrainHorizon = {
  maximumElevationDegrees: number;
  distanceMeters: number;
};

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("可視判定を中止しました", "AbortError");
}


function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  abortIfRequested(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("可視判定を中止しました", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
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

function subjectExclusionMarginMeters(subjectDistanceMeters: number): number {
  // 被写体地点そのものを遮蔽物と誤判定しないため、終端直前を除外する。
  // DEMの解像度・位置誤差を考慮し、距離の1%を基準に25〜100mへ制限する。
  return Math.min(100, Math.max(25, subjectDistanceMeters * 0.01));
}

async function calculateHorizon(
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  azimuthDegrees: number,
  maximumDistanceMeters: number,
  signal?: AbortSignal
): Promise<TerrainHorizon> {
  abortIfRequested(signal);
  const origin = Cartesian3.fromDegrees(
    tripod.longitude,
    tripod.latitude,
    tripod.height + lensCenterHeightMeters
  );
  if (maximumDistanceMeters <= 8) {
    return { maximumElevationDegrees: -90, distanceMeters: 0 };
  }
  const clampedMaximumDistanceMeters = Math.min(
    TERRAIN_DISTANCE_LIMIT_METERS,
    maximumDistanceMeters
  );
  // クライアント側 (src/cesium/celestialOcclusion.ts) と共通の
  // Adaptive Step地形プロファイル走査を使用し、検索結果とプレビューの
  // 遮蔽判定を一致させる。
  const result = await scanAdaptiveTerrainProfile(
    origin,
    clampedMaximumDistanceMeters,
    async (distances) => {
      abortIfRequested(signal);
      const sampled = await sampleServerLineOfSightTerrain(
        distances.map((distance) => destinationCartographic(tripod, azimuthDegrees, distance)),
        distances,
        signal
      );
      abortIfRequested(signal);
      return sampled;
    }
  );
  return {
    maximumElevationDegrees: result.maximumElevationDegrees,
    distanceMeters: result.distanceMeters,
  };
}

function cacheKey(
  tripod: GroundPoint,
  lensCenterHeightMeters: number,
  azimuthDegrees: number,
  maximumDistanceMeters: number
): string {
  return [
    tripod.latitude.toFixed(6),
    tripod.longitude.toFixed(6),
    tripod.height.toFixed(1),
    lensCenterHeightMeters.toFixed(2),
    (Math.round((((azimuthDegrees % 360) + 360) % 360) / 0.02) * 0.02).toFixed(2),
    Math.round(maximumDistanceMeters).toString(),
  ].join(":");
}

export function createServerLineOfSightEvaluator(
  lensCenterHeightMeters: number
): (
  tripod: GroundPoint,
  horizontal: HorizontalCoordinates,
  subjectDistanceMeters: number,
  signal?: AbortSignal
) => Promise<CelestialOcclusion> {
  return async (tripod, horizontal, subjectDistanceMeters, signal) => {
    if (horizontal.altitudeDegrees <= 0) {
      return {
        verificationState: "dem-only",
        visible: false,
        verified: true,
        terrainObstructed: true,
        photorealisticMeshObstructed: false,
        reason: "below-horizon",
        obstructionElevationDegrees: 0,
        obstructionDistanceMeters: 0,
      };
    }
    const exclusionMarginMeters = subjectExclusionMarginMeters(subjectDistanceMeters);
    const maximumDistanceMeters = Math.max(0, subjectDistanceMeters - exclusionMarginMeters);
    const key = cacheKey(
      tripod,
      lensCenterHeightMeters,
      horizontal.azimuthDegrees,
      maximumDistanceMeters
    );
    const pendingTerrainHorizon = horizonCache.getOrCreate(key, () =>
      calculateHorizon(
        tripod,
        lensCenterHeightMeters,
        horizontal.azimuthDegrees,
        maximumDistanceMeters
      )
    );

    // Phase6-1: DEM LOSとOSM建物・植生LOSは相互依存しないため並列取得する。
    // 従来はDEM完了後にOSMを開始しており、ネットワーク待ち時間が加算されていた。
    const pendingSurfaceHorizon = lookupSurfaceObstructionHorizon(
      {
        latitude: tripod.latitude,
        longitude: tripod.longitude,
        groundElevationMeters: tripod.height,
        lensCenterHeightMeters,
      },
      horizontal.azimuthDegrees,
      maximumDistanceMeters,
      signal
    );
    const [horizon, surfaceHorizon] = await Promise.all([
      awaitWithAbort(pendingTerrainHorizon, signal),
      pendingSurfaceHorizon,
    ]);

    // Phase2〜3: OSM由来の建物・樹木高さ（DEM+DSM統合）による遮蔽も
    // DEM地形と同じ土俵で評価し、どちらか高い方（より遮蔽的な方）を採用する。
    const surfaceIsHigher =
      surfaceHorizon.maximumElevationDegrees > horizon.maximumElevationDegrees;
    const combinedElevationDegrees = surfaceIsHigher
      ? surfaceHorizon.maximumElevationDegrees
      : horizon.maximumElevationDegrees;
    const combinedDistanceMeters = surfaceIsHigher
      ? surfaceHorizon.distanceMeters ?? horizon.distanceMeters
      : horizon.distanceMeters;

    const terrainDecision = classifyTerrainOcclusion(
      horizontal.altitudeDegrees,
      combinedElevationDegrees,
      undefined,
      combinedDistanceMeters
    );
    const terrainObstructed = terrainDecision.status === "obstructed";
    return {
      verificationState: "dem-only",
      visible: !terrainObstructed,
      verified: true,
      terrainObstructed,
      photorealisticMeshObstructed: false,
      reason: terrainObstructed
        ? (surfaceIsHigher ? "building-or-surface" : "terrain")
        : "visible",
      obstructionElevationDegrees: combinedElevationDegrees,
      obstructionDistanceMeters: terrainObstructed
        ? combinedDistanceMeters
        : undefined,
    };
  };
}
