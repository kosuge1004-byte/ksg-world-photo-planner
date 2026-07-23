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
const SAMPLE_COUNT = 32;
const ROOT_REFINEMENT_PASSES = 3;
const ROOT_REFINEMENT_SEGMENTS = 8;
const CONVERGED_POSITION_METERS = 0.05;
const CONVERGED_HORIZONTAL_DEGREES = 0.0001;

export type TerrainSampler = (
  points: Cartographic[],
  signal?: AbortSignal
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

function logarithmicDistances(
  distanceRange?: TripodDistanceRange
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
  return Array.from({ length: SAMPLE_COUNT }, (_, index) =>
    minimum * ratio ** (index / (SAMPLE_COUNT - 1))
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

async function solveTerrainDistance(
  subject: GroundPoint,
  bearingDegrees: number,
  targetAltitudeDegrees: number,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange
): Promise<TerrainSolution | null> {
  abortIfRequested(signal);
  const distances = logarithmicDistances(distanceRange);
  if (distances.length === 0) return null;
  const sampled = await terrainSampler(
    distances.map((distance) =>
      destinationCartographic(subject, bearingDegrees, distance)
    ),
    signal
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
  for (let pass = 0; pass < ROOT_REFINEMENT_PASSES; pass += 1) {
    // 7点を一括取得して8分割する。3段階で9回二分探索相当の区間精度を保ち、
    // 高精度DEMへの逐次通信を最大9往復から3往復へ減らす。
    const step = (highDistance - lowDistance) / ROOT_REFINEMENT_SEGMENTS;
    const refinementDistances = Array.from(
      { length: ROOT_REFINEMENT_SEGMENTS - 1 },
      (_, index) => lowDistance + step * (index + 1)
    );
    const refinementSamples = await terrainSampler(
      refinementDistances.map((distance) =>
        destinationCartographic(subject, bearingDegrees, distance)
      ),
      signal
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

async function calculateOneCandidate(
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  date: Date,
  calculationMode: CalculationMode,
  terrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange
): Promise<TripodCandidate | null> {
  const lensCenterHeightMeters = cameraSettings.lensCenterHeightMeters;
  let horizontal = {
    azimuthDegrees: point.azimuthDegrees,
    altitudeDegrees: point.altitudeDegrees,
  };
  let solved: TripodCandidate | null = null;

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
      distanceRange
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
  distanceRange?: TripodDistanceRange
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
    (point) => point.altitudeDegrees > 0.25
  );
  const results = await Promise.all(
    visiblePoints.map((point) =>
      calculateOneCandidate(
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        terrainSampler,
        signal,
        distanceRange
      )
    )
  );
  abortIfRequested(signal);
  return results.filter((candidate): candidate is TripodCandidate => Boolean(candidate));
}

