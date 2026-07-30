import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  type Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";
import type { SpotPresetResult } from "../types/search";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { HorizontalCoordinates } from "../types/celestial";
import { calculateKarneyDestinationPoint, calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import { fetchSiteContexts } from "../search/siteContext";
import { sampleWorldTerrainHighestPrecision } from "../cesium/worldTerrain";
import {
  evaluatePhotorealisticMeshSegmentLineOfSight,
  evaluatePhotorealisticMeshLineOfSight,
  prepareCelestialLineOfSightObserver,
} from "../cesium/celestialOcclusion";
import {
  calculateCelestialHorizontalCoordinates,
  celestialAngularDiameterDegrees,
} from "../cesium/celestial";
import { calculateElevationAngleDegrees } from "../cesium/geometry";
import { sensorDimensionsMm } from "../cesium/camera";
import { createSearchProgressEstimator } from "../search/searchProgress";

export type HighestPrecisionProgress = {
  percent: number;
  message: string;
  processed?: number;
  total?: number;
  estimatedRemainingSeconds?: number | null;
};

export type HighestPrecisionResult = {
  subject: GroundPoint;
  tripod: GroundPoint;
};

type CompositionVerifiedCandidate = {
  point: GroundPoint;
  compositionErrorDegrees: number;
  celestialHorizontal: HorizontalCoordinates;
};

function angularDifferenceDegrees(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function verifyComposition(
  candidate: GroundPoint,
  subject: GroundPoint,
  result: SpotPresetResult,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode
): CompositionVerifiedCandidate | null {
  const lens = {
    ...candidate,
    height: candidate.height + cameraSettings.lensCenterHeightMeters,
    label: "高精度三脚レンズ中心",
  };
  const celestial = calculateCelestialHorizontalCoordinates(
    result.celestialId,
    result.date,
    lens,
    calculationMode
  );
  if (celestial.altitudeDegrees <= 0.25) return null;
  const subjectAzimuth = calculateKarneyLineMetrics(candidate, subject).bearingDegrees;
  const subjectAltitude = calculateElevationAngleDegrees(lens, subject);
  const azimuthError = angularDifferenceDegrees(
    celestial.azimuthDegrees,
    subjectAzimuth
  );
  const altitudeError = Math.abs(
    celestial.altitudeDegrees - subjectAltitude
  );
  const sensor = sensorDimensionsMm(Math.max(0.25, previewAspectRatio));
  const horizontalHalfFov = CesiumMath.toDegrees(
    Math.atan(sensor.width / (2 * Math.max(1, cameraSettings.focalLengthMm)))
  );
  const verticalHalfFov = CesiumMath.toDegrees(
    Math.atan(sensor.height / (2 * Math.max(1, cameraSettings.focalLengthMm)))
  );
  const discRadius = result.celestialId === "moon"
    ? 0.285
    : result.celestialId === "sun"
      ? 0.272
      : 0;
  // 最終座標で円盤全体（天の川は中心）が指定焦点距離の画角内に入る場合だけ採用する。
  if (
    azimuthError + discRadius > horizontalHalfFov ||
    altitudeError + discRadius > verticalHalfFov
  ) {
    return null;
  }
  return {
    point: candidate,
    compositionErrorDegrees: Math.hypot(
      azimuthError / Math.max(0.001, horizontalHalfFov),
      altitudeError / Math.max(0.001, verticalHalfFov)
    ),
    celestialHorizontal: celestial,
  };
}

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
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  onProgress: (progress: HighestPrecisionProgress) => void,
  signal?: AbortSignal
): Promise<HighestPrecisionResult> {
  const progressEstimator = createSearchProgressEstimator(1);
  const reportProgress = (
    percent: number,
    message: string,
    processed?: number,
    total?: number
  ): void => {
    const estimate = progressEstimator.update(1, percent);
    if (!estimate) return;
    onProgress({
      percent: estimate.percent,
      message,
      processed,
      total,
      estimatedRemainingSeconds: estimate.estimatedRemainingSeconds,
    });
  };

  reportProgress(8, "局所再探索地点を作成しています");
  const rawCandidates = localCandidates(result.tripod);

  reportProgress(20, "道路外・歩行不可地点を除外しています");
  const contexts = await fetchSiteContexts(rawCandidates, signal, false);
  const walkable = rawCandidates.filter((_, index) => {
    const context = contexts[index];
    return context.walkingAccessible && !context.restrictedAccess && !context.onMotorRoad;
  });
  if (walkable.length === 0) throw new Error("歩行可能な高精度候補地点がありません");

  reportProgress(38, "最詳細DEMと地点別ジオイドを取得しています");
  const terrainInputs = [result.subject, ...walkable].map((point) =>
    Cartographic.fromDegrees(point.longitude, point.latitude, 0)
  );
  const terrain = await sampleWorldTerrainHighestPrecision(terrainInputs, signal);
  const terrainSubject = groundPoint(terrain[0], result.subject.label);
  const terrainCandidates = terrain.slice(1).map((sample) => groundPoint(sample, "高精度三脚位置"));

  reportProgress(58, "Google 3D Tiles の最詳細LODを読み込んでいます");
  const [meshSubject, ...meshCandidates] = await clampMostDetailed(
    viewer,
    [terrainSubject, ...terrainCandidates],
    signal
  );

  reportProgress(72, "ECEF座標で視線と遮蔽物を再判定しています");
  const targetEcef = Cartesian3.fromDegrees(
    meshSubject.longitude,
    meshSubject.latitude,
    meshSubject.height
  );
  const verified: CompositionVerifiedCandidate[] = [];
  for (let index = 0; index < meshCandidates.length; index += 1) {
    const candidate = meshCandidates[index];
    const observer = await prepareCelestialLineOfSightObserver(
      viewer,
      candidate,
      cameraSettings.lensCenterHeightMeters,
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
    const composition = verifyComposition(
      candidate,
      meshSubject,
      result,
      cameraSettings,
      previewAspectRatio,
      calculationMode
    );
    const celestialLineOfSight = composition
      ? await evaluatePhotorealisticMeshLineOfSight(
          viewer,
          observer,
          composition.celestialHorizontal,
          signal,
          undefined,
          {
            angularDiameterDegrees: celestialAngularDiameterDegrees(
              result.celestialId,
              result.date,
              candidate
            ),
            detailSettings: {
              detailedEdgeCheckEnabled:
                result.celestialId === "sun" || result.celestialId === "moon",
              edgeSampleCount: 12,
              // 最高精度では中心または縁の1点でも遮蔽されれば候補を確定しない。
              obstructedThresholdPercent: 1,
            },
          }
        )
      : null;
    if (
      lineOfSight.verified &&
      lineOfSight.visible &&
      composition &&
      celestialLineOfSight?.verified &&
      celestialLineOfSight.visible
    ) {
      verified.push(composition);
    }
    reportProgress(
      72 + Math.round(((index + 1) / meshCandidates.length) * 22),
      `高精度の遮蔽物判定中 ${index + 1}/${meshCandidates.length}`,
      index + 1,
      meshCandidates.length
    );
  }
  if (verified.length === 0) {
    throw new Error("高精度データでは構図と建物遮蔽の両条件を満たす三脚地点を確認できません");
  }

  const tripod = verified.reduce((best, candidate) => {
    const errorDifference =
      candidate.compositionErrorDegrees - best.compositionErrorDegrees;
    if (Math.abs(errorDifference) > 1e-6) {
      return errorDifference < 0 ? candidate : best;
    }
    const bestOffset = calculateKarneyLineMetrics(result.tripod, best.point).distanceMeters;
    const candidateOffset = calculateKarneyLineMetrics(result.tripod, candidate.point).distanceMeters;
    return candidateOffset < bestOffset ? candidate : best;
  }).point;
  reportProgress(100, "高精度座標を確定しました");
  return { subject: meshSubject, tripod };
}
