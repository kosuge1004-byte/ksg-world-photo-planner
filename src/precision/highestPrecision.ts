import {
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  type Viewer,
} from "cesium";

import type { GroundPoint, ResolvedGroundPoint } from "../types/points";
import { withLensCenterHeight } from "../types/points";
import type { SpotPresetResult } from "../types/search";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { HorizontalCoordinates } from "../types/celestial";
import { calculateKarneyDestinationPoint, calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import { fetchSiteContexts } from "../search/siteContext";
import { sampleWorldTerrainHighestPrecision, geoidHeightMetersForHighestPrecisionSample } from "../cesium/worldTerrain";
import {
  evaluatePhotorealisticMeshSegmentLineOfSight,
  evaluatePhotorealisticMeshLineOfSight,
  prepareCelestialLineOfSightObserver,
} from "../cesium/celestialOcclusion";
import {
  calculateCelestialHorizontalCoordinates,
  celestialAngularDiameterDegrees,
  createCameraProjection,
  isCelestialInCameraFrame,
  projectHorizontalToPreview,
} from "../cesium/celestial";
import { computeApparentElevation } from "../apparent/apparentElevation";
import { createSearchProgressEstimator } from "../search/searchProgress";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

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

function verifyComposition(
  candidate: GroundPoint,
  subject: GroundPoint,
  result: SpotPresetResult,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): CompositionVerifiedCandidate | null {
  // withLensCenterHeight()で楕円体高・標高の両方を一貫して更新する
  // （.heightだけを更新するとellipsoidalHeightMeters/orthometricHeightMeters
  // が古い値のまま残り、標高と楕円体高が混在する）。
  const lens = withLensCenterHeight(candidate, cameraSettings.lensCenterHeightMeters, "高精度三脚レンズ中心");
  const celestial = calculateCelestialHorizontalCoordinates(
    result.celestialId,
    result.date,
    lens,
    calculationMode,
    refractionWeather
  );
  if (celestial.altitudeDegrees <= 0.25) return null;
  const subjectAzimuth = calculateKarneyLineMetrics(candidate, subject).bearingDegrees;
  // 最終構図判定はApparent同士（見かけ天体位置 vs 見かけ被写体位置）で比較する。
  const subjectElevation = computeApparentElevation(lens, subject, calculationMode);
  const subjectAltitude = subjectElevation.apparentAltitudeDegrees;

  // 画角判定・最終構図判定はProjectionService経由の中心投影
  // （projectToScreen()）で行う。人物・被写体・天体・軌跡と同一の投影経路。
  const projection = createCameraProjection(
    candidate,
    subject,
    cameraSettings,
    previewAspectRatio,
    calculationMode
  );
  if (!isCelestialInCameraFrame(
    result.celestialId,
    result.date,
    lens,
    celestial,
    projection,
    calculationMode,
    refractionWeather
  )) {
    return null;
  }

  const celestialScreen = projectHorizontalToPreview(celestial, projection);
  const subjectScreen = projectHorizontalToPreview(
    { azimuthDegrees: subjectAzimuth, altitudeDegrees: subjectAltitude, geometricAltitudeDegrees: subjectElevation.geometricAltitudeDegrees },
    projection
  );
  // 順位付け用の構図誤差（画面パーセント距離を半画角=50%で正規化）。
  // 採否そのものはisCelestialInCameraFrame()（画角・円盤サイズ込み）で決まる。
  const compositionErrorDegrees = Math.hypot(
    (celestialScreen.xPercent - subjectScreen.xPercent) / 50,
    (celestialScreen.yPercent - subjectScreen.yPercent) / 50
  );
  return {
    point: candidate,
    compositionErrorDegrees,
    celestialHorizontal: celestial,
  };
}

function groundPoint(sample: Cartographic, label: string): ResolvedGroundPoint {
  // sampleWorldTerrainHighestPrecision()で取得した地点固有ジオイド高を使い、
  // 楕円体高（sample.height）と標高（orthometricHeightMeters）を両方明示する。
  // 標高と楕円体高の混在を避けるため、ここで一度だけ変換する。
  const ellipsoidalHeightMeters = sample.height;
  const geoidHeightMeters = geoidHeightMetersForHighestPrecisionSample(sample);
  return {
    latitude: CesiumMath.toDegrees(sample.latitude),
    longitude: CesiumMath.toDegrees(sample.longitude),
    height: ellipsoidalHeightMeters,
    ellipsoidalHeightMeters,
    orthometricHeightMeters: ellipsoidalHeightMeters - geoidHeightMeters,
    geoidHeightMeters,
    heightSource: "dem",
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
  points: ResolvedGroundPoint[],
  signal?: AbortSignal
): Promise<ResolvedGroundPoint[]> {
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
    // Google 3D Tilesのメッシュ表面高（屋上・橋面など）へクランプし直しても、
    // ジオイド分離量は水平方向にごくゆるやかにしか変化しないため、DEM取得時に
    // 得た同地点のジオイド高をそのまま再利用して標高を再計算する。
    const ellipsoidalHeightMeters = cartographic.height;
    const geoidHeightMeters = points[index].geoidHeightMeters;
    return {
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      height: ellipsoidalHeightMeters,
      ellipsoidalHeightMeters,
      orthometricHeightMeters: ellipsoidalHeightMeters - geoidHeightMeters,
      geoidHeightMeters,
      heightSource: "3d-picked",
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
  refractionWeather?: RefractionWeatherContext,
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
      calculationMode,
      refractionWeather
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
