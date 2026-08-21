import { createAbortError, isAbortError } from "../utils/runtimeErrors";
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
import { ellipsoidalHeightMeters } from "../types/points";
import type { CalculationMode, CameraSettings } from "../types/camera";
import { calculateCelestialHorizontalCoordinates } from "./celestial";
import { sensorDimensionsMm } from "./camera";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
} from "../geodesy/karneyGeodesic";
import { sampleWorldTerrain } from "./worldTerrain";
import { computeApparentElevation } from "../apparent/apparentElevation";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

const ABSOLUTE_MIN_DISTANCE_METERS = 8;
const ABSOLUTE_MAX_DISTANCE_METERS = 50_000;
// 初回は粗い距離走査で画角内候補を絞り、交差区間だけ詳細化する。
const DEFAULT_SAMPLE_COUNT = 32;
// 精密化は固定575点取得ではなく、交差区間だけを32分割して2段階で絞る。
// 32^2=1024分割相当となるため、従来の576分割より最終距離分解能は高い。
// 各段階で使うDEMは従来どおり1m指定のままなので、高さ精度も落とさない。
// 取得点数は最大575点→62点程度となり、通信負荷と一時失敗率を大幅に下げる。
const DEFAULT_ROOT_REFINEMENT_PASSES = 2;
const DEFAULT_ROOT_REFINEMENT_SEGMENTS = 32;
const CONVERGED_POSITION_METERS = 0.05;
// 収束判定の角度は、探索エンジン自身がどこでも「収束」と扱っている許容誤差
// （0.002度）に揃える。従来の0.0001度（0.36秒角）は1mメッシュDEMの実測精度
// より20倍以上厳しく、データの精度を超えた桁を追いかけて3回目の反復（＝
// 追加のDEM通信往復）をほぼ毎回発生させていた。ここを緩めても、探索の
// 最終的な角度誤差の許容値自体は変えていないため、得られる位置の精度は
// 従来と変わらない。
const CONVERGED_HORIZONTAL_DEGREES = 0.002;
export const DEFAULT_DIRECTION_CANDIDATE_DISTANCE_METERS = 500;

export type TerrainSampler = (
  points: Cartographic[],
  signal?: AbortSignal,
  maximumDetail?: "1m" | "5m" | "10m"
) => Promise<Cartographic[]>;

export type RefractionWeatherResolver = (
  point: GroundPoint,
  signal?: AbortSignal
) => Promise<RefractionWeatherContext | undefined>;

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError("計算を中止しました");
}

/**
 * 新方式の主計算: 天体→被写体を通る見かけ視線を被写体の反対側へ延長し、
 * WGS84楕円体との交点から三脚距離の第一候補を直接求める。
 *
 * ここで得る値はあくまで「第一候補距離」。実地形、レンズ中心高、地上屈折、
 * 気象連動大気差は後段の既存1m DEM/ECEF/Apparent計算で必ず再検証する。
 * したがって楕円体近似を最終解として採用することはない。
 */
function directSightlineSeedDistanceMeters(
  subject: GroundPoint,
  celestialAzimuthDegrees: number,
  apparentAltitudeDegrees: number
): number | null {
  if (
    !Number.isFinite(subject.latitude) ||
    !Number.isFinite(subject.longitude) ||
    !Number.isFinite(ellipsoidalHeightMeters(subject)) ||
    !Number.isFinite(celestialAzimuthDegrees) ||
    !Number.isFinite(apparentAltitudeDegrees) ||
    apparentAltitudeDegrees <= 0
  ) return null;

  const lat = CesiumMath.toRadians(subject.latitude);
  const lon = CesiumMath.toRadians(subject.longitude);
  const bearing = CesiumMath.toRadians((celestialAzimuthDegrees + 180) % 360);
  const elevation = CesiumMath.toRadians(-apparentAltitudeDegrees);

  // ENU基底。ECEFで直線を作るため、地球の丸みはWGS84楕円体そのものとして扱う。
  const east = new Cartesian3(-Math.sin(lon), Math.cos(lon), 0);
  const north = new Cartesian3(
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat)
  );
  const up = new Cartesian3(
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat)
  );
  const horizontalScale = Math.cos(elevation);
  const direction = new Cartesian3(
    east.x * Math.sin(bearing) * horizontalScale +
      north.x * Math.cos(bearing) * horizontalScale +
      up.x * Math.sin(elevation),
    east.y * Math.sin(bearing) * horizontalScale +
      north.y * Math.cos(bearing) * horizontalScale +
      up.y * Math.sin(elevation),
    east.z * Math.sin(bearing) * horizontalScale +
      north.z * Math.cos(bearing) * horizontalScale +
      up.z * Math.sin(elevation)
  );
  Cartesian3.normalize(direction, direction);

  const origin = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    ellipsoidalHeightMeters(subject),
    Ellipsoid.WGS84
  );
  const radii = Ellipsoid.WGS84.radii;
  const ox = origin.x / radii.x;
  const oy = origin.y / radii.y;
  const oz = origin.z / radii.z;
  const dx = direction.x / radii.x;
  const dy = direction.y / radii.y;
  const dz = direction.z / radii.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const discriminant = b * b - 4 * a * c;
  if (!(a > 0) || discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  const t = [t1, t2].filter((value) => Number.isFinite(value) && value > 0).sort((x, y) => x - y)[0];
  if (!Number.isFinite(t)) return null;

  const intersection = Cartesian3.add(
    origin,
    Cartesian3.multiplyByScalar(direction, t, new Cartesian3()),
    new Cartesian3()
  );
  const cartographic = Ellipsoid.WGS84.cartesianToCartographic(intersection);
  if (!cartographic) return null;
  const intersectionPoint: GroundPoint = {
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    height: 0,
    label: "視線楕円体交点",
  };
  const distance = calculateKarneyLineMetrics(subject, intersectionPoint).distanceMeters;
  return Number.isFinite(distance) && distance >= ABSOLUTE_MIN_DISTANCE_METERS
    ? Math.min(ABSOLUTE_MAX_DISTANCE_METERS, distance)
    : null;
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
  lensCenterHeightMeters: number,
  calculationMode: CalculationMode
): number {
  const observer: GroundPoint = {
    latitude: CesiumMath.toDegrees(candidate.latitude),
    longitude: CesiumMath.toDegrees(candidate.longitude),
    height: candidate.height + lensCenterHeightMeters,
    label: "三脚候補レンズ中心",
  };

  // 三脚候補探索と撮影プレビューで、同一のECEF仰角・地表屈折補正（Apparent層）を使用する。
  // これにより、探索時は一致しているのにプレビューで上下にずれる不整合を防ぐ。
  return computeApparentElevation(observer, subject, calculationMode).apparentAltitudeDegrees;
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
  calculationMode: CalculationMode,
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
    elevationAngleDegrees(
      candidate,
      subject,
      lensCenterHeightMeters,
      calculationMode
    ) - targetAltitudeDegrees
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
    // 現在の交差区間だけを一括取得する適応精密化。各passで符号が変わる
    // 最小区間へ絞り込むため、全区間を固定高密度で取得する必要がない。
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
        ? elevationAngleDegrees(
          candidate,
          subject,
          lensCenterHeightMeters,
          calculationMode
        ) - targetAltitudeDegrees
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
  calculationMode: CalculationMode,
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
        elevationAngleDegrees(
          preferredSample,
          subject,
          lensCenterHeightMeters,
          calculationMode
        ) - targetAltitudeDegrees;
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
        calculationMode,
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
    calculationMode,
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
  searchProfile?: TripodSearchProfile,
  refractionWeather?: RefractionWeatherContext,
  refractionWeatherResolver?: RefractionWeatherResolver
): Promise<TripodCandidate | null> {
  const lensCenterHeightMeters = cameraSettings.lensCenterHeightMeters;
  let horizontal = {
    azimuthDegrees: point.azimuthDegrees,
    altitudeDegrees: point.altitudeDegrees,
  };
  let solved: TripodCandidate | null = null;
  let iterationSearchProfile = searchProfile;
  let activeRefractionWeather = refractionWeather;

  // 観測地点が動くと方位・高度も変わるため、候補地点のレンズ中心で収束するまで再計算する。
  for (let iteration = 0; iteration < 3; iteration += 1) {
    abortIfRequested(signal);
    if (horizontal.altitudeDegrees <= 0.25) return null;

    const bearing = (horizontal.azimuthDegrees + 180) % 360;

    // 新方式を主軸にする。天体→被写体のECEF/WGS84視線から直接得た距離を
    // 最初に1m DEMで検証し、外れた場合だけ周辺探索→現行全探索へ戻る。
    // 天体高度 horizontal.altitudeDegrees は calculateCelestialHorizontalCoordinates()
    // 由来なので、pro時の標準大気差または気温・気圧・湿度連動補正を既に含む。
    const directSeedDistance = directSightlineSeedDistanceMeters(
      subject,
      horizontal.azimuthDegrees,
      horizontal.altitudeDegrees
    );
    const hybridSearchProfile: TripodSearchProfile | undefined = {
      ...iterationSearchProfile,
      preferredDistanceMeters:
        directSeedDistance ?? iterationSearchProfile?.preferredDistanceMeters,
    };
    const solution = await solveTerrainDistance(
      subject,
      bearing,
      horizontal.altitudeDegrees,
      lensCenterHeightMeters,
      calculationMode,
      terrainSampler,
      signal,
      distanceRange,
      hybridSearchProfile
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
    if (refractionWeatherResolver) {
      const resolvedWeather = await refractionWeatherResolver(
        {
          latitude: solved.latitude,
          longitude: solved.longitude,
          height: solved.height,
          label: `${point.label}三脚候補気象地点`,
        },
        signal
      );
      abortIfRequested(signal);
      if (resolvedWeather) activeRefractionWeather = resolvedWeather;
    }
    const nextHorizontal = calculateCelestialHorizontalCoordinates(
      point.id,
      date,
      {
        ...solved,
        height: solved.height + lensCenterHeightMeters,
        label: `${point.label}三脚候補レンズ中心`,
      },
      calculationMode,
      activeRefractionWeather
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
    calculationMode,
    activeRefractionWeather
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
    elevationAngleDegrees(
      candidateCartographic,
      subject,
      lensCenterHeightMeters,
      calculationMode
    ) - finalHorizontal.altitudeDegrees
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
  searchProfile?: TripodSearchProfile,
  refractionWeather?: RefractionWeatherContext,
  // 天体ごとに方位が異なるため、単一のsearchProfile.preferredDistanceMetersでは
  // 全天体を代表できない。呼び出し側が把握している「天体ID→前回の確定距離」を
  // ここで受け取り、天体ごとに個別のヒントとして使う。
  // （spotPresetSearch.tsの前回距離再利用と同じ考え方。id未登録の天体は
  // 通常どおりsearchProfile.preferredDistanceMetersにフォールバックする。）
  preferredDistancesById?: Partial<Record<CelestialScreenPoint["id"], number>>,
  refractionWeatherResolver?: RefractionWeatherResolver
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

  // 精度優先: DEM取得失敗時に被写体高度で代用しない。
  // 高度基準が不明な候補は確定結果へ含めず、取得エラーを呼び出し側へ返す。


  const results = await Promise.allSettled(
    visiblePoints.map((point) => {
      const preferredDistanceMeters = preferredDistancesById?.[point.id];
      const pointSearchProfile: TripodSearchProfile | undefined =
        preferredDistanceMeters !== undefined
          ? { ...searchProfile, preferredDistanceMeters }
          : searchProfile;
      return calculateOneCandidate(
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        terrainSampler,
        signal,
        distanceRange,
        pointSearchProfile,
        refractionWeather,
        refractionWeatherResolver
      );
    })
  );
  abortIfRequested(signal);

  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  const aborted = rejected.find((result) => isAbortError(result.reason));
  if (aborted) throw aborted.reason;

  const candidates = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );

  if (rejected.length > 0) {
    console.warn(
      `三脚候補の一部計算に失敗しました (${rejected.length}/${visiblePoints.length})`,
      rejected.map((result) => result.reason)
    );
  }

  // 全天体が地形取得エラーになった場合だけ、呼び出し側へ「計算失敗」を返す。
  // 一部だけ失敗した場合は正常に得られた候補を維持する。
  if (visiblePoints.length > 0 && rejected.length === visiblePoints.length) {
    throw new AggregateError(
      rejected.map((result) => result.reason),
      "すべての三脚候補で地形データ取得に失敗しました"
    );
  }

  return candidates;
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
    if (isAbortError(error)) {
      throw error;
    }
    console.warn(
      "三脚方位候補の地表高度を取得できないため、地表クランプ表示を使用します",
      error
    );
    return candidates;
  }
}
