import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  type Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";
import type { SpotPresetResult } from "../types/search";
import { calculateKarneyDestinationPoint, calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import { fetchSiteContexts } from "../search/siteContext";
import { sampleWorldTerrainHighestPrecision } from "../cesium/worldTerrain";
import {
  evaluatePhotorealisticMeshSegmentLineOfSight,
  prepareCelestialLineOfSightObserver,
} from "../cesium/celestialOcclusion";

export type HighestPrecisionProgress = {
  percent: number;
  message: string;
};

export type HighestPrecisionResult = {
  subject: GroundPoint;
  tripod: GroundPoint;
};

function groundPoint(sample: Cartographic, label: string): GroundPoint {
  return {
    latitude: CesiumMath.toDegrees(sample.latitude),
    longitude: CesiumMath.toDegrees(sample.longitude),
    height: sample.height,
    label,
  };
}

function localCandidates(origin: GroundPoint): GroundPoint[] {
  const points: GroundPoint[] = [origin];
  for (const radius of [5, 10, 15, 20]) {
    for (let bearing = 0; bearing < 360; bearing += 30) {
      const coordinate = calculateKarneyDestinationPoint(origin, bearing, radius);
      points.push({ ...coordinate, height: origin.height, label: "高精度三脚候補" });
    }
  }
  return points;
}

async function clampMostDetailed(
  viewer: Viewer,
  points: GroundPoint[],
  signal?: AbortSignal
): Promise<GroundPoint[]> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const positions = points.map((point) =>
    Cartesian3.fromDegrees(point.longitude, point.latitude, point.height)
  );
  const clamped = await viewer.scene.clampToHeightMostDetailed(
    positions,
    [...viewer.entities.values],
    0.01
  );
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (clamped.some((position) => !position)) {
    throw new Error("Google Photorealistic 3D Tiles の最詳細表面を取得できません");
  }
  return clamped.map((position, index) => {
    const cartographic = Cartographic.fromCartesian(position!);
    return {
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      height: cartographic.height,
      label: points[index].label,
    };
  });
}

export async function refineSpotPresetHighestPrecision(
  viewer: Viewer,
  result: SpotPresetResult,
  lensCenterHeightMeters: number,
  onProgress: (progress: HighestPrecisionProgress) => void,
  signal?: AbortSignal
): Promise<HighestPrecisionResult> {
  onProgress({ percent: 8, message: "局所再探索地点を作成しています" });
  const rawCandidates = localCandidates(result.tripod);

  onProgress({ percent: 20, message: "道路外・歩行不可地点を除外しています" });
  const contexts = await fetchSiteContexts(rawCandidates, signal, false);
  const walkable = rawCandidates.filter((_, index) => {
    const context = contexts[index];
    return context.walkingAccessible && !context.restrictedAccess && !context.onMotorRoad;
  });
  if (walkable.length === 0) throw new Error("歩行可能な高精度候補地点がありません");

  onProgress({ percent: 38, message: "最詳細DEMと地点別ジオイドを取得しています" });
  const terrainInputs = [result.subject, ...walkable].map((point) =>
    Cartographic.fromDegrees(point.longitude, point.latitude, 0)
  );
  const terrain = await sampleWorldTerrainHighestPrecision(terrainInputs, signal);
  const terrainSubject = groundPoint(terrain[0], result.subject.label);
  const terrainCandidates = terrain.slice(1).map((sample) => groundPoint(sample, "高精度三脚位置"));

  onProgress({ percent: 58, message: "Google 3D Tiles の最詳細LODを読み込んでいます" });
  const [meshSubject, ...meshCandidates] = await clampMostDetailed(
    viewer,
    [terrainSubject, ...terrainCandidates],
    signal
  );

  onProgress({ percent: 72, message: "ECEF座標で視線と遮蔽物を再判定しています" });
  const targetEcef = Cartesian3.fromDegrees(
    meshSubject.longitude,
    meshSubject.latitude,
    meshSubject.height
  );
  const verified: GroundPoint[] = [];
  for (let index = 0; index < meshCandidates.length; index += 1) {
    const candidate = meshCandidates[index];
    const observer = await prepareCelestialLineOfSightObserver(
      viewer,
      candidate,
      lensCenterHeightMeters,
      signal
    );
    const distance = Cartesian3.distance(observer.meshOrigin, targetEcef);
    const lineOfSight = await evaluatePhotorealisticMeshSegmentLineOfSight(
      viewer,
      observer,
      targetEcef,
      signal,
      Math.max(0, distance - 0.5)
    );
    if (lineOfSight.verified && lineOfSight.visible) verified.push(candidate);
    onProgress({
      percent: 72 + Math.round(((index + 1) / meshCandidates.length) * 22),
      message: `高精度の遮蔽物判定中 ${index + 1}/${meshCandidates.length}`,
    });
  }
  if (verified.length === 0) throw new Error("高精度データでは被写体への見通しを確認できません");

  const tripod = verified.reduce((best, candidate) => {
    const bestOffset = calculateKarneyLineMetrics(result.tripod, best).distanceMeters;
    const candidateOffset = calculateKarneyLineMetrics(result.tripod, candidate).distanceMeters;
    return candidateOffset < bestOffset ? candidate : best;
  });
  onProgress({ percent: 100, message: "高精度座標を確定しました" });
  return { subject: meshSubject, tripod };
}
