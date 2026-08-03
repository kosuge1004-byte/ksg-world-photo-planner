import {
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Math as CesiumMath,
} from "cesium";

import type {
  CelestialScreenPoint,
  TripodCandidate,
} from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { CalculationMode, CameraSettings } from "../types/camera";
import { calculateCelestialHorizontalCoordinates } from "./celestial";
import { sensorDimensionsMm } from "./camera";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
} from "../geodesy/karneyGeodesic";
import { sampleWorldTerrain } from "./worldTerrain";

const ABSOLUTE_MIN_DISTANCE_METERS = 8;
const ABSOLUTE_MAX_DISTANCE_METERS = 50_000;
// 初回は粗い距離走査で画角内候補を絞り、交差区間だけ詳細化する。
const DEFAULT_SAMPLE_COUNT = 32;
// 8分割を3往復（512分割相当）する代わりに、24分割を2往復する。
// 576分割相当へ精度を上げつつ、DEM APIの待機を1往復減らす。
const DEFAULT_ROOT_REFINEMENT_PASSES = 2;
const DEFAULT_ROOT_REFINEMENT_SEGMENTS = 24;
const CONVERGED_POSITION_METERS = 0.05;
const CONVERGED_HORIZONTAL_DEGREES = 0.0001;
export const DEFAULT_DIRECTION_CANDIDATE_DISTANCE_METERS = 500;

export type TerrainSampler = (
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetail?: "1m" | "5m" | "10m"
) => Promise<Cartographic[]>;

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("計算を中止しました", "AbortError");
}

function destinationCartographic(
  origin: GroundPoint,
  bearingDegrees: number,
  distanceMeters: number
): Cartographic {
  const destination = calculateKarneyDestinationPoint(
    origin,
    bearingDegrees,
    distanceMeters
  );
  return Cartographic.fromDegrees(
    destination.longitude,
    destination.latitude,
    0
  );
}

function elevationAngleDegrees(
  candidate: Cartographic,
  subject: GroundPoint,
  lensCenterHeightMeters: number
): number {
  const cameraPosition = Cartesian3.fromRadians(
    candidate.longitude,
    candidate.latitude,
    candidate.height + lensCenterHeightMeters
  );
  const subjectPosition = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subject.height
  );
  const direction = Cartesian3.normalize(
    Cartesian3.subtract(subjectPosition, cameraPosition, new Cartesian3()),
    new Cartesian3()
  );
  const localUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
    cameraPosition,
    new Cartesian3()
  );
  return CesiumMath.toDegrees(
    Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(direction, localUp))))
  );
}

export type TripodDistanceRange = {
  minMeters: number;
  maxMeters: number;
};

export type TripodSearchProfile = {
  sampleCount?: number;
  refinementPasses?: number;
  refinementSegments?: number;
  /** 近接日時で得た前回解。精度判定を満たす場合だけ再利用し、外れた場合は従来の全探索へ進む。 */
  preferredDistanceMeters?: number;
};

function logarithmicDistances(
  distanceRange?: TripodDistanceRange,
  sampleCount = DEFAULT_SAMPLE_COUNT
): number[] {
  const requestedMin = distanceRange?.minMeters ?? ABSOLUTE_MIN_DISTANCE_METERS;
  const requestedMax = distanceRange?.maxMeters ?? ABSOLUTE_MAX_DISTANCE_METERS;
  const minimum = Math.max(ABSOLUTE_MIN_DISTANCE_METERS, requestedMin);
  const maximum = Math.min(ABSOLUTE_MAX_DISTANCE_METERS, requestedMax);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) {
    return [];
  }
  if (maximum === minimum) return [minimum];
  const ratio = maximum / minimum;
  const resolvedSampleCount = Math.max(4, Math.floor(sampleCount));
  return Array.from({ length: resolvedSampleCount }, (_, index) =>
    minimum * ratio ** (index / (resolvedSampleCount - 1))
  );
}

function angularDifferenceDegrees(a: number, b: number): number {
  const difference = ((a - b + 540) % 360) - 180;
  return Math.abs(difference);
}

function cameraHalfFieldOfViewDegrees(
  settings: CameraSettings,
  aspectRatio: number
): { horizontal: number; vertical: number } {
  const sensor = sensorDimensionsMm(aspectRatio);
  return {
    horizontal: CesiumMath.toDegrees(
      Math.atan(sensor.width / (2 * settings.focalLengthMm))
    ),
    vertical: CesiumMath.toDegrees(
      Math.atan(sensor.height / (2 * settings.focalLengthMm))
    ),
  };
}

function celestialDiscRadiusDegrees(id: CelestialScreenPoint["id"]): number | null {
  // 画角内に円盤全体が収まるかを判定するのは太陽・月だけ。
  // 天の川・北極星は従来どおり候補計算を行い、この円盤判定の対象外とする。
  if (id === "moon") return 0.285;
  if (id === "sun") return 0.272;
  return null;
}

type TerrainSolution = {
  cartographic: Cartographic;
  distanceMeters: number;
  altitudeErrorDegrees: number;
};

async function scanTerrainDistanceRange(
  subject: GroundPoint,
  bearingDegrees: number,
  targetAltitudeDegrees: number,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal: AbortSignal | undefined,
  distanceRange: TripodDistanceRange | undefined,
  searchProfile: TripodSearchProfile | undefined
): Promise<TerrainSolution | null> {
  const distances = logarithmicDistances(
    distanceRange,
    searchProfile?.sampleCount ?? DEFAULT_SAMPLE_COUNT
  );
  if (distances.length === 0) return null;
  const sampled = await terrainSampler(
    distances.map((distance) =>
      destinationCartographic(subject, bearingDegrees, distance)
    ),
    signal,
    // 全距離走査は交差区間を探す工程なので10m DEMで十分です。
    // 確定座標は下の精密化工程で1m DEMを使い、精度を落とさず通信量を削減します。
    "10m"
  );
  abortIfRequested(signal);
  const errors = sampled.map((candidate) =>
    elevationAngleDegrees(candidate, subject, lensCenterHeightMeters) -
      targetAltitudeDegrees
  );
  const firstFiniteIndex = errors.findIndex(Number.isFinite);
  if (firstFiniteIndex < 0) return null;
  const bestIndex = errors.reduce(
    (best, error, index) =>
      Number.isFinite(error) && Math.abs(error) < Math.abs(errors[best])
        ? index
        : best,
    firstFiniteIndex
  );

  let crossingIndex = -1;
  for (let index = 1; index < errors.length; index += 1) {
    if (!Number.isFinite(errors[index - 1]) || !Number.isFinite(errors[index])) {
      continue;
    }
    if (errors[index - 1] * errors[index] <= 0) {
      crossingIndex = index;
      break;
    }
  }

  let best: TerrainSolution = {
    cartographic: sampled[bestIndex],
    distanceMeters: distances[bestIndex],
    altitudeErrorDegrees: errors[bestIndex],
  };
  if (crossingIndex < 1) return best;

  let lowDistance = distances[crossingIndex - 1];
  let highDistance = distances[crossingIndex];
  let lowError = errors[crossingIndex - 1];
  let highError = errors[crossingIndex];
  const refinementPasses = Math.max(0, Math.floor(
    searchProfile?.refinementPasses ?? DEFAULT_ROOT_REFINEMENT_PASSES
  ));
  const refinementSegments = Math.max(2, Math.floor(
    searchProfile?.refinementSegments ?? DEFAULT_ROOT_REFINEMENT_SEGMENTS
  ));
  for (let pass = 0; pass < refinementPasses; pass += 1) {
    // 区間内の複数点を一括取得し、逐次二分探索より少ない通信往復で精密化する。
    const step = (highDistance - lowDistance) / refinementSegments;
    const refinementDistances = Array.from(
      { length: refinementSegments - 1 },
      (_, index) => lowDistance + step * (index + 1)
    );
    const refinementSamples = await terrainSampler(
      refinementDistances.map((distance) =>
        destinationCartographic(subject, bearingDegrees, distance)
      ),
      signal,
      "1m"
    );
    abortIfRequested(signal);
    const refinementErrors = refinementSamples.map((candidate) =>
      candidate && Number.isFinite(candidate.height)
        ? elevationAngleDegrees(candidate, subject, lensCenterHeightMeters) -
          targetAltitudeDegrees
        : Number.NaN
    );
    for (let index = 0; index < refinementErrors.length; index += 1) {
      const error = refinementErrors[index];
      if (Number.isFinite(error) && Math.abs(error) < Math.abs(best.altitudeErrorDegrees)) {
        best = {
          cartographic: refinementSamples[index],
          distanceMeters: refinementDistances[index],
          altitudeErrorDegrees: error,
        };
      }
    }
    if (Math.abs(best.altitudeErrorDegrees) <= 0.002) break;

    const sectionDistances = [
      lowDistance,
      ...refinementDistances,
      highDistance,
    ];
    const sectionErrors = [lowError, ...refinementErrors, highError];
    let nextSection = -1;
    for (let index = 1; index < sectionErrors.length; index += 1) {
      const previousError = sectionErrors[index - 1];
      const error = sectionErrors[index];
      if (
        Number.isFinite(previousError) &&
        Number.isFinite(error) &&
        previousError * error <= 0
      ) {
        nextSection = index;
        break;
      }
    }
    if (nextSection < 1) break;
    lowDistance = sectionDistances[nextSection - 1];
    highDistance = sectionDistances[nextSection];
    lowError = sectionErrors[nextSection - 1];
    highError = sectionErrors[nextSection];
  }
  return best;
}

async function solveTerrainDistance(
  subject: GroundPoint,
  bearingDegrees: number,
  targetAltitudeDegrees: number,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange,
  searchProfile?: TripodSearchProfile
): Promise<TerrainSolution | null> {
  abortIfRequested(signal);
  const preferredDistance = searchProfile?.preferredDistanceMeters;
  const minimum = distanceRange?.minMeters ?? ABSOLUTE_MIN_DISTANCE_METERS;
  const maximum = distanceRange?.maxMeters ?? ABSOLUTE_MAX_DISTANCE_METERS;
  if (
    Number.isFinite(preferredDistance) &&
    preferredDistance! >= minimum &&
    preferredDistance! <= maximum
  ) {
    const [preferredSample] = await terrainSampler([
      destinationCartographic(subject, bearingDegrees, preferredDistance!),
    ], signal, "1m");
    abortIfRequested(signal);
    if (preferredSample && Number.isFinite(preferredSample.height)) {
      const preferredError =
        elevationAngleDegrees(preferredSample, subject, lensCenterHeightMeters) -
        targetAltitudeDegrees;
      // 従来の精密化終了条件と同じ角度誤差を満たす場合だけ前回解を採用する。
      if (Math.abs(preferredError) <= 0.002) {
        return {
          cartographic: preferredSample,
          distanceMeters: preferredDistance!,
          altitudeErrorDegrees: preferredError,
        };
      }
    }

    // 前回解の周辺だけを先に精密探索する。解が十分収束しない場合は、
    // 必ず元の全距離範囲を再探索して局所解による取りこぼしを防ぐ。
    const localRange: TripodDistanceRange = {
      minMeters: Math.max(minimum, preferredDistance! * 0.65),
      maxMeters: Math.min(maximum, preferredDistance! * 1.35),
    };
    if (localRange.maxMeters >= localRange.minMeters) {
      const localSolution = await scanTerrainDistanceRange(
        subject,
        bearingDegrees,
        targetAltitudeDegrees,
        lensCenterHeightMeters,
        terrainSampler,
        signal,
        localRange,
        searchProfile
      );
      if (
        localSolution &&
        Math.abs(localSolution.altitudeErrorDegrees) <= 0.002
      ) {
        return localSolution;
      }
    }
  }

  return scanTerrainDistanceRange(
    subject,
    bearingDegrees,
    targetAltitudeDegrees,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    distanceRange,
    searchProfile
  );
}

async function calculateOneCandidate(
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  date: Date,
  calculationMode: CalculationMode,
  terrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange,
  searchProfile?: TripodSearchProfile
): Promise<TripodCandidate | null> {
  const lensCenterHeightMeters = cameraSettings.lensCenterHeightMeters;
  let horizontal = {
    azimuthDegrees: point.azimuthDegrees,
    altitudeDegrees: point.altitudeDegrees,
  };
  let solved: TripodCandidate | null = null;
  let iterationSearchProfile = searchProfile;

  // 観測地点が動くと方位・高度も変わるため、候補地点のレンズ中心で収束するまで再計算する。
  for (let iteration = 0; iteration < 3; iteration += 1) {
    abortIfRequested(signal);
    if (horizontal.altitudeDegrees <= 0.25) return null;

    const bearing = (horizontal.azimuthDegrees + 180) % 360;
    const solution = await solveTerrainDistance(
      subject,
      bearing,
      horizontal.altitudeDegrees,
      lensCenterHeightMeters,
      terrainSampler,
      signal,
      distanceRange,
      iterationSearchProfile
    );
    if (!solution || !Number.isFinite(solution.cartographic.height)) return null;
    const candidate = solution.cartographic;
    const previousSolved = solved;

    solved = {
      id: point.id,
      label: point.label,
      latitude: CesiumMath.toDegrees(candidate.latitude),
      longitude: CesiumMath.toDegrees(candidate.longitude),
      height: candidate.height,
      distanceMeters: solution.distanceMeters,
      solutionType: "aligned",
    };
    // 2回目以降は直前の精密解を最初に検証する。判定許容値を満たさない場合は
    // solveTerrainDistance内で局所探索・全探索へ戻るため、精度を維持したまま高速化できる。
    iterationSearchProfile = {
      ...searchProfile,
      preferredDistanceMeters: solution.distanceMeters,
    };
    const nextHorizontal = calculateCelestialHorizontalCoordinates(
      point.id,
      date,
      {
        ...solved,
        height: solved.height + lensCenterHeightMeters,
        label: `${point.label}三脚候補レンズ中心`,
      },
      calculationMode
    );
    const positionChangeMeters = previousSolved
      ? Cartesian3.distance(
          Cartesian3.fromDegrees(
            previousSolved.longitude,
            previousSolved.latitude,
            previousSolved.height
          ),
          Cartesian3.fromDegrees(solved.longitude, solved.latitude, solved.height)
        )
      : Number.POSITIVE_INFINITY;
    const horizontalChangeDegrees = Math.hypot(
      angularDifferenceDegrees(
        nextHorizontal.azimuthDegrees,
        horizontal.azimuthDegrees
      ),
      nextHorizontal.altitudeDegrees - horizontal.altitudeDegrees
    );
    horizontal = nextHorizontal;

    // 同一解へ収束した後の重いDEM再走査だけを省く。
    if (
      positionChangeMeters <= CONVERGED_POSITION_METERS &&
      horizontalChangeDegrees <= CONVERGED_HORIZONTAL_DEGREES
    ) {
      break;
    }
  }

  if (!solved) return null;
  const candidatePoint: GroundPoint = {
    latitude: solved.latitude,
    longitude: solved.longitude,
    height: solved.height,
    label: `${point.label}三脚候補`,
  };
  const finalHorizontal = calculateCelestialHorizontalCoordinates(
    point.id,
    date,
    {
      ...candidatePoint,
      height: candidatePoint.height + lensCenterHeightMeters,
    },
    calculationMode
  );
  const subjectBearing = calculateKarneyLineMetrics(
    candidatePoint,
    subject
  ).bearingDegrees;
  const candidateCartographic = Cartographic.fromDegrees(
    solved.longitude,
    solved.latitude,
    solved.height
  );
  const altitudeError = Math.abs(
    elevationAngleDegrees(candidateCartographic, subject, lensCenterHeightMeters) -
    finalHorizontal.altitudeDegrees
  );
  const azimuthError = angularDifferenceDegrees(
    subjectBearing,
    finalHorizontal.azimuthDegrees
  );
  const halfFov = cameraHalfFieldOfViewDegrees(
    cameraSettings,
    previewAspectRatio
  );
  const celestialRadius = celestialDiscRadiusDegrees(point.id) ?? 0;

  // 一致度や順位は算出せず、フルサイズの指定焦点距離で天体が画角内に入るかだけを判定する。
  if (
    azimuthError + celestialRadius > halfFov.horizontal ||
    altitudeError + celestialRadius > halfFov.vertical
  ) {
    return null;
  }
  return solved;
}

export async function calculateTripodCandidates(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  cameraSettingsOrLensHeight: CameraSettings | number,
  date: Date,
  calculationMode: CalculationMode,
  terrainSampler: TerrainSampler = sampleWorldTerrain,
  signal?: AbortSignal,
  previewAspectRatio = 3 / 2,
  distanceRange?: TripodDistanceRange,
  searchProfile?: TripodSearchProfile
): Promise<TripodCandidate[]> {
  const cameraSettings: CameraSettings = typeof cameraSettingsOrLensHeight === "number"
    ? {
        focalLengthMm: 24,
        lensCenterHeightMeters: cameraSettingsOrLensHeight,
      }
    : cameraSettingsOrLensHeight;
  abortIfRequested(signal);
  // 太陽・月に限定すると、同じ候補計算を共有する天の川・北極星が
  // アプリ全体から消えるため、地平線上にある有効な天体をすべて対象にする。
  const visiblePoints = points.filter(
    (point) => Number.isFinite(point.altitudeDegrees) && point.altitudeDegrees > 0.25
  );

  // GSI/Cesium Terrain の一時障害で候補計算全体が0件になることを防ぐ。
  // 高度取得に失敗した場合は被写体地点の楕円体高を暫定地表高として使い、
  // 候補位置の幾何計算を継続する。通信復旧後の次回計算では通常DEMへ戻る。
  const resilientTerrainSampler: TerrainSampler = async (
    requested,
    requestedSignal,
    maximumDetail
  ) => {
    try {
      const sampled = await terrainSampler(
        requested,
        requestedSignal,
        maximumDetail
      );
      return requested.map((point, index) => {
        const value = sampled[index];
        if (value && Number.isFinite(value.height)) return value;
        const fallback = Cartographic.clone(point);
        fallback.height = Number.isFinite(subject.height) ? subject.height : 0;
        return fallback;
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      console.warn("地形高度を取得できないため暫定高度で三脚候補計算を継続します", error);
      return requested.map((point) => {
        const fallback = Cartographic.clone(point);
        fallback.height = Number.isFinite(subject.height) ? subject.height : 0;
        return fallback;
      });
    }
  };

  const results = await Promise.all(
    visiblePoints.map((point) =>
      calculateOneCandidate(
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        resilientTerrainSampler,
        signal,
        distanceRange,
        searchProfile
      )
    )
  );
  abortIfRequested(signal);
  return results.filter((candidate): candidate is TripodCandidate => Boolean(candidate));
}

export function buildDirectionalTripodCandidates(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  distanceMeters = DEFAULT_DIRECTION_CANDIDATE_DISTANCE_METERS
): TripodCandidate[] {
  const resolvedDistance = Math.min(
    ABSOLUTE_MAX_DISTANCE_METERS,
    Math.max(ABSOLUTE_MIN_DISTANCE_METERS, distanceMeters)
  );
  return points.flatMap((point) => {
    if (
      !Number.isFinite(point.azimuthDegrees) ||
      !Number.isFinite(point.altitudeDegrees) ||
      point.altitudeDegrees <= 0.25
    ) {
      return [];
    }
    const destination = calculateKarneyDestinationPoint(
      subject,
      (point.azimuthDegrees + 180) % 360,
      resolvedDistance
    );
    return [{
      id: point.id,
      label: point.label,
      latitude: destination.latitude,
      longitude: destination.longitude,
      // 3D描画側で地表へクランプする。DEM取得後は実高度へ置き換わる。
      height: 0,
      distanceMeters: resolvedDistance,
      solutionType: "direction-only" as const,
    }];
  });
}

export async function sampleDirectionalTripodCandidates(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  terrainSampler: TerrainSampler = sampleWorldTerrain,
  signal?: AbortSignal,
  distanceMeters = DEFAULT_DIRECTION_CANDIDATE_DISTANCE_METERS
): Promise<TripodCandidate[]> {
  const candidates = buildDirectionalTripodCandidates(
    subject,
    points,
    distanceMeters
  );
  if (candidates.length === 0) return [];
  const requested = candidates.map((candidate) =>
    Cartographic.fromDegrees(candidate.longitude, candidate.latitude, 0)
  );
  try {
    const sampled = await terrainSampler(requested, signal);
    abortIfRequested(signal);
    return candidates.map((candidate, index) => ({
      ...candidate,
      height: Number.isFinite(sampled[index]?.height)
        ? sampled[index].height
        : 0,
    }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    console.warn(
      "三脚方位候補の地表高度を取得できないため、地表クランプ表示を使用します",
      error
    );
    return candidates;
  }
}
