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
import {
  calculateCelestialHorizontalCoordinates,
  createCameraProjection,
  projectHorizontalToPreview,
} from "./celestial";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
} from "../geodesy/karneyGeodesic";
import { sampleWorldTerrain, terrainDataSource } from "./worldTerrain";
import { computeApparentElevation } from "../apparent/apparentElevation";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

const ABSOLUTE_MIN_DISTANCE_METERS = 8;
const ABSOLUTE_MAX_DISTANCE_METERS = 50_000;
// 初回は粗い距離走査で画角内候補を絞り、交差区間だけ詳細化する。
const DEFAULT_SAMPLE_COUNT = 32;
// 交点取りこぼし防止用の補助走査。初期32点は維持しつつ、広すぎる区間だけを
// 10m DEMで一括補間する。全域を1m化しないため、精度向上と通信量抑制を両立する。
const ADAPTIVE_COARSE_MAX_SPAN_METERS = 500;
const ADAPTIVE_NEAR_RAY_MAX_SPAN_METERS = 100;
const ADAPTIVE_NEAR_RAY_ERROR_DEGREES = 0.12;
const ADAPTIVE_MAX_TOTAL_SAMPLES = 640;
// 精密化は固定575点取得ではなく、交差区間だけを32分割して2段階で絞る。
// 32^2=1024分割相当となるため、従来の576分割より最終距離分解能は高い。
// 各段階で使うDEMは従来どおり1m指定のままなので、高さ精度も落とさない。
// 取得点数は最大575点→62点程度となり、通信負荷と一時失敗率を大幅に下げる。
const DEFAULT_ROOT_REFINEMENT_PASSES = 2;
const DEFAULT_ROOT_REFINEMENT_SEGMENTS = 32;
// 収束判定の角度は、探索エンジン自身がどこでも「収束」と扱っている許容誤差
// （0.002度）に揃える。従来の0.0001度（0.36秒角）は1mメッシュDEMの実測精度
// より20倍以上厳しく、データの精度を超えた桁を追いかけて3回目の反復（＝
// 追加のDEM通信往復）をほぼ毎回発生させていた。ここを緩めても、探索の
// 最終的な角度誤差の許容値自体は変えていないため、得られる位置の精度は
// 従来と変わらない。
const CONVERGED_HORIZONTAL_DEGREES = 0.002;
// Round-trip検証（仕様3-G）: 候補地点を既存プレビューと同じCameraModel/Projection
// 経路へ逆投入し、天体中心と被写体中心のスクリーン座標差（画面幅・高さに対する
// 割合）を確認する。角度収束条件（CONVERGED_HORIZONTAL_DEGREES）を満たしていれば
// 通常はこの範囲に収まるが、投影の非線形性（望遠レンズでの接線補正等）による
// 残差を別経路で二重に検出するための独立したしきい値。
const ROUND_TRIP_SCREEN_TOLERANCE_PERCENT = 0.5;
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
 * 「天体中心 → 被写体 → 後方」の3Dレイ（ECEF直線）。
 *
 * 天体は被写体近傍のどの地点から見てもほぼ同一方向にある（太陽・月とも
 * 視差は無視できるほど遠い）。したがって、被写体を通り天体方向を指す
 * 単位ベクトルは、被写体位置のENU基底で一度だけ組み立てれば、以降の
 * 探索区間（数百m〜数km）全域で有効な固定方向として扱える。
 *
 * origin/directionはECEF実座標（メートル単位）。tがそのまま被写体からの
 * 直線距離（メートル）になる。
 */
export type CelestialSubjectRay = {
  origin: Cartesian3;
  direction: Cartesian3;
};

export function buildCelestialBackwardRay(
  subject: GroundPoint,
  celestialAzimuthDegrees: number,
  apparentAltitudeDegrees: number
): CelestialSubjectRay | null {
  if (
    !Number.isFinite(subject.latitude) ||
    !Number.isFinite(subject.longitude) ||
    !Number.isFinite(ellipsoidalHeightMeters(subject)) ||
    !Number.isFinite(celestialAzimuthDegrees) ||
    !Number.isFinite(apparentAltitudeDegrees)
  ) return null;

  const lat = CesiumMath.toRadians(subject.latitude);
  const lon = CesiumMath.toRadians(subject.longitude);
  // 三脚は天体と反対側（被写体を挟んで反対の方位・下向きの仰角）に立つ。
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
  return { origin, direction };
}

/**
 * レイ上の距離tにおける地点（緯度経度・楕円体高）。tは被写体からのECEF
 * 直線距離（メートル）。高さは楕円体高（レイがWGS84楕円体上でどの高さに
 * あるか）で、地形高ではない。地形との交差判定は呼び出し側でDEM高との
 * 差として行う。
 */
export function rayCartographicAtDistance(
  ray: CelestialSubjectRay,
  distanceMeters: number
): Cartographic | null {
  const position = Cartesian3.add(
    ray.origin,
    Cartesian3.multiplyByScalar(ray.direction, distanceMeters, new Cartesian3()),
    new Cartesian3()
  );
  return Ellipsoid.WGS84.cartesianToCartographic(position);
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
  if (apparentAltitudeDegrees <= 0) return null;
  const ray = buildCelestialBackwardRay(subject, celestialAzimuthDegrees, apparentAltitudeDegrees);
  if (!ray) return null;

  const radii = Ellipsoid.WGS84.radii;
  const ox = ray.origin.x / radii.x;
  const oy = ray.origin.y / radii.y;
  const oz = ray.origin.z / radii.z;
  const dx = ray.direction.x / radii.x;
  const dy = ray.direction.y / radii.y;
  const dz = ray.direction.z / radii.z;
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

  // scanRayTerrainIntersections の距離軸はECEFレイ上の t（直線距離）。
  // ここでKarney地表距離へ変換すると距離軸が混在し、特に高仰角でseedが
  // 不必要に手前へずれる。二次的な測地線計算も不要なので、求めたtをそのまま使う。
  return t >= ABSOLUTE_MIN_DISTANCE_METERS
    ? Math.min(ABSOLUTE_MAX_DISTANCE_METERS, t)
    : null;
}

/**
 * 高さ基準を混同しないための候補地点GroundPoint生成。
 *
 * DEM（sampleWorldTerrain）は楕円体高だけを返し、地点別ジオイド高は
 * 取得しない。ジオイド分離量は数kmの範囲では極めて滑らかに変化するため、
 * 被写体側で既に解決済みのジオイド高（resolveGroundPoint等で取得済みの
 * 場合）を候補地点へそのまま流用する。被写体側にジオイド情報がない場合は
 * 明示的なorthometric/geoidを設定せず、`orthometricHeightMeters()`の
 * 通常フォールバック（≒楕円体高）へ委ねる。ここで「楕円体高をlegacy
 * heightとして代用する」新たな混同を発生させないことが目的。
 */
export function buildCandidateGroundPoint(
  cartographic: Cartographic,
  subject: GroundPoint,
  label: string
): GroundPoint {
  const ellipsoidal = cartographic.height;
  const geoid = subject.geoidHeightMeters;
  const hasGeoid = Number.isFinite(geoid);
  return {
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: hasGeoid ? ellipsoidal - (geoid as number) : undefined,
    geoidHeightMeters: hasGeoid ? (geoid as number) : undefined,
    heightSource: "dem",
    label,
  };
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

function uniqueSortedDistances(values: number[]): number[] {
  return values
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) >= 0.01);
}

function densifyDistanceIntervals(
  distances: number[],
  maximumSpanMeters: number,
  maximumTotalSamples = ADAPTIVE_MAX_TOTAL_SAMPLES
): number[] {
  if (distances.length < 2 || !(maximumSpanMeters > 0)) return distances;
  const output: number[] = [distances[0]];
  for (let index = 1; index < distances.length; index += 1) {
    const low = distances[index - 1];
    const high = distances[index];
    const span = high - low;
    const segments = Math.max(1, Math.ceil(span / maximumSpanMeters));
    for (let segment = 1; segment <= segments; segment += 1) {
      if (output.length >= maximumTotalSamples && segment < segments) continue;
      output.push(low + span * (segment / segments));
    }
  }
  return uniqueSortedDistances(output).slice(0, maximumTotalSamples);
}


// 注意（仕様3-D）: 画角/FOV/焦点距離や天体の視円盤半径を理由に候補を
// 除外する処理はここには置かない。円盤半径は表示専用（celestial.ts側の
// apparentDisc）であり、三脚候補の位置決定に混ぜてはならない。

/**
 * レイ方式の主計算用サンプリング。
 *
 * 「天体中心→被写体→後方」の3Dレイは、レンズ中心（三脚+レンズ中心高）が
 * 通る線である（レンズ中心が被写体・天体と一直線に並ぶ、というのが
 * そもそもの構図条件のため）。したがって、レイ上の点の高さから
 * レンズ中心高を引いた値が「その距離に三脚を置いたときの地面の高さ」に
 * 一致する地点こそが、地形との交点（＝三脚候補）である。
 * レンズ中心高を引かずに地形高と直接比較すると、レンズ中心高の分だけ
 * 系統的にずれた地点を交点として検出してしまう
 * （例: レンズ高1.6m・距離500mでは約0.18度に相当するずれ）。
 *
 * 仰角一致（旧方式のelevationAngleDegrees比較）ではなく、レイそのものの
 * 高さと地形高の差を直接比較するため、仕様3-Cが求める
 * 「3Dレイと地形表面の交点」を文字通り計算する。
 */
async function sampleRayTerrainErrors(
  ray: CelestialSubjectRay,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal: AbortSignal | undefined,
  distances: number[],
  maximumDetail: "1m" | "5m" | "10m"
): Promise<{ rayPoints: Cartographic[]; samples: Cartographic[]; errors: number[] }> {
  const rayPoints = distances.map((distance) => {
    const point = rayCartographicAtDistance(ray, distance);
    // レイがWGS84楕円体の裏側などに回り込み計算不能な場合は、地形問い合わせを
    // スキップできるよう明らかに無効な値（NaN高さ）を持つダミー点にする。
    return point ?? Cartographic.fromRadians(0, 0, Number.NaN);
  });
  const samples = await terrainSampler(
    rayPoints.map((point) => Cartographic.clone(point)),
    signal,
    maximumDetail
  );
  abortIfRequested(signal);
  const errors = samples.map((sample, index) => {
    const rayPoint = rayPoints[index];
    return sample && Number.isFinite(sample.height) && Number.isFinite(rayPoint.height)
      ? (rayPoint.height - lensCenterHeightMeters) - sample.height
      : Number.NaN;
  });
  return { rayPoints, samples, errors };
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


/**
 * 新方式（本計算）: 「天体中心→被写体→後方」のECEF3Dレイと地形表面の
 * 交点をすべて求める。仕様3-Cの通り、Karney測地線上のbearing走査ではなく、
 * レイの楕円体高と実地形高（DEM）の差の符号変化から交点を検出する。
 *
 * 探索の刻み方・適応細分化・複数交点の一括精密化バッチは、既存の
 * scanAllTerrainIntersections（旧方式・ダブルチェック専用）と同系統のロジックを
 * 使用する。初回の探索範囲だけは directSightlineSeedDistanceMeters のseedを使って
 * 必要範囲へ絞り、解が無い場合に限って残りを拡張する。誤差の意味は
 * 「仰角差（度）」ではなく「レイ高と地形高の差（m）」。
 */
async function scanRayTerrainIntersections(
  ray: CelestialSubjectRay,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal: AbortSignal | undefined,
  distanceRange: TripodDistanceRange | undefined,
  searchProfile: TripodSearchProfile | undefined,
  preferredDistanceMeters?: number
): Promise<TerrainSolution[]> {
  let baseDistances = logarithmicDistances(
    distanceRange,
    searchProfile?.sampleCount ?? DEFAULT_SAMPLE_COUNT
  );
  if (Number.isFinite(preferredDistanceMeters)) {
    const minimum = distanceRange?.minMeters ?? ABSOLUTE_MIN_DISTANCE_METERS;
    const maximum = distanceRange?.maxMeters ?? ABSOLUTE_MAX_DISTANCE_METERS;
    if (preferredDistanceMeters! >= minimum && preferredDistanceMeters! <= maximum) {
      baseDistances.push(preferredDistanceMeters!);
    }
  }
  baseDistances = uniqueSortedDistances(baseDistances);
  if (baseDistances.length < 2) return [];

  // 第1段階: 遠距離側で対数サンプル間隔が大きくなりすぎないよう500m上限で一括補完。
  let distances = densifyDistanceIntervals(baseDistances, ADAPTIVE_COARSE_MAX_SPAN_METERS);
  let { samples: sampled, errors } = await sampleRayTerrainErrors(
    ray,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    distances,
    "10m"
  );

  // 第2段階: 同符号でもレイ（高さ差ゼロ）へ接近している区間だけ追加細分化。
  const additionalDistances: number[] = [];
  for (let index = 1; index < distances.length; index += 1) {
    const previous = errors[index - 1];
    const current = errors[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    if (previous * current <= 0) continue;
    const span = distances[index] - distances[index - 1];
    if (span <= ADAPTIVE_NEAR_RAY_MAX_SPAN_METERS) continue;
    // 高さ差（m）ベースの近接判定。地表付近では傾斜次第で角度しきい値を
    // そのままメートルへ流用できないため、区間内の最小距離に対する見かけの
    // 勾配（前後点の高さ差 / 区間長）が緩やかな場合を「レイに接近」とみなす。
    const nearRay = Math.min(Math.abs(previous), Math.abs(current)) <= ADAPTIVE_NEAR_RAY_ERROR_DEGREES * distances[index] * 0.05;
    const left = index >= 2 ? errors[index - 2] : Number.NaN;
    const right = index + 1 < errors.length ? errors[index + 1] : Number.NaN;
    const localApproach =
      (Number.isFinite(left) && Math.abs(previous) < Math.abs(left)) ||
      (Number.isFinite(right) && Math.abs(current) < Math.abs(right));
    if (!nearRay && !localApproach) continue;
    const segments = Math.max(2, Math.ceil(span / ADAPTIVE_NEAR_RAY_MAX_SPAN_METERS));
    for (let segment = 1; segment < segments; segment += 1) {
      additionalDistances.push(distances[index - 1] + span * (segment / segments));
    }
  }

  if (additionalDistances.length > 0) {
    const remainingCapacity = Math.max(0, ADAPTIVE_MAX_TOTAL_SAMPLES - distances.length);
    const additions = uniqueSortedDistances(additionalDistances).slice(0, remainingCapacity);
    if (additions.length > 0) {
      const { samples: addedSamples, errors: addedErrors } = await sampleRayTerrainErrors(
        ray,
        lensCenterHeightMeters,
        terrainSampler,
        signal,
        additions,
        "10m"
      );
      const merged = [
        ...distances.map((distance, index) => ({ distance, sample: sampled[index], error: errors[index] })),
        ...additions.map((distance, index) => ({ distance, sample: addedSamples[index], error: addedErrors[index] })),
      ].sort((a, b) => a.distance - b.distance);
      distances = merged.map((item) => item.distance);
      sampled = merged.map((item) => item.sample);
      errors = merged.map((item) => item.error);
    }
  }

  const brackets: Array<{ lowIndex: number; highIndex: number }> = [];
  for (let index = 1; index < errors.length; index += 1) {
    const previous = errors[index - 1];
    const current = errors[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    if (previous === 0 || current === 0 || previous * current < 0) {
      brackets.push({ lowIndex: index - 1, highIndex: index });
    }
  }
  if (brackets.length === 0) return [];

  const refinementPasses = Math.max(0, Math.floor(
    searchProfile?.refinementPasses ?? DEFAULT_ROOT_REFINEMENT_PASSES
  ));
  const refinementSegments = Math.max(2, Math.floor(
    searchProfile?.refinementSegments ?? DEFAULT_ROOT_REFINEMENT_SEGMENTS
  ));
  // 高さ差（m）の収束しきい値。DEMの実測精度（1mメッシュ）に対して十分小さく、
  // かつ最終的な合否は仕様3-Gのround-trip検証（角度・スクリーン座標）が
  // 別途下すため、ここでは交点位置を十分絞り込む役割に留める。
  const CONVERGED_HEIGHT_METERS = 0.01;

  type RefinementState = {
    lowDistance: number;
    highDistance: number;
    lowError: number;
    highError: number;
    best: TerrainSolution;
    done: boolean;
  };
  const states: RefinementState[] = brackets.map((bracket) => {
    const lowDistance = distances[bracket.lowIndex];
    const highDistance = distances[bracket.highIndex];
    const lowError = errors[bracket.lowIndex];
    const highError = errors[bracket.highIndex];
    const best = Math.abs(lowError) <= Math.abs(highError)
      ? { cartographic: sampled[bracket.lowIndex], distanceMeters: lowDistance, altitudeErrorDegrees: lowError }
      : { cartographic: sampled[bracket.highIndex], distanceMeters: highDistance, altitudeErrorDegrees: highError };
    return { lowDistance, highDistance, lowError, highError, best, done: false };
  });

  for (let pass = 0; pass < refinementPasses; pass += 1) {
    abortIfRequested(signal);
    const pending = states
      .map((state, stateIndex) => ({ state, stateIndex }))
      .filter(({ state }) => !state.done);
    if (pending.length === 0) break;

    const requests: Array<{ stateIndex: number; distance: number }> = [];
    for (const { state, stateIndex } of pending) {
      const step = (state.highDistance - state.lowDistance) / refinementSegments;
      for (let index = 1; index < refinementSegments; index += 1) {
        requests.push({ stateIndex, distance: state.lowDistance + step * index });
      }
    }
    const refinementDistances = requests.map((request) => request.distance);
    const { samples: refinementSamples, errors: refinementErrors } = await sampleRayTerrainErrors(
      ray,
      lensCenterHeightMeters,
      terrainSampler,
      signal,
      refinementDistances,
      "1m"
    );

    for (const { state, stateIndex } of pending) {
      const indices = requests
        .map((request, requestIndex) => ({ request, requestIndex }))
        .filter(({ request }) => request.stateIndex === stateIndex);
      const localDistances = indices.map(({ request }) => request.distance);
      const localSamples = indices.map(({ requestIndex }) => refinementSamples[requestIndex]);
      const localErrors = indices.map(({ requestIndex }) => refinementErrors[requestIndex]);

      for (let index = 0; index < localErrors.length; index += 1) {
        const error = localErrors[index];
        if (Number.isFinite(error) && Math.abs(error) < Math.abs(state.best.altitudeErrorDegrees)) {
          state.best = {
            cartographic: localSamples[index],
            distanceMeters: localDistances[index],
            altitudeErrorDegrees: error,
          };
        }
      }
      if (Math.abs(state.best.altitudeErrorDegrees) <= CONVERGED_HEIGHT_METERS) {
        state.done = true;
        continue;
      }

      const sectionDistances = [state.lowDistance, ...localDistances, state.highDistance];
      const sectionErrors = [state.lowError, ...localErrors, state.highError];
      let nextSection = -1;
      for (let index = 1; index < sectionErrors.length; index += 1) {
        const previous = sectionErrors[index - 1];
        const current = sectionErrors[index];
        if (Number.isFinite(previous) && Number.isFinite(current) && previous * current <= 0) {
          nextSection = index;
          break;
        }
      }
      if (nextSection < 1) {
        state.done = true;
        continue;
      }
      state.lowDistance = sectionDistances[nextSection - 1];
      state.highDistance = sectionDistances[nextSection];
      state.lowError = sectionErrors[nextSection - 1];
      state.highError = sectionErrors[nextSection];
    }
  }

  const solutions: TerrainSolution[] = [];
  for (const state of states) {
    if (!Number.isFinite(state.best.cartographic.height)) continue;
    const duplicate = solutions.some((solution) => Math.abs(solution.distanceMeters - state.best.distanceMeters) < 0.5);
    if (!duplicate) solutions.push(state.best);
  }

  // ユーザーが遠い候補から確認できるよう距離降順。候補は自動除外しない（仕様3-D）。
  return solutions.sort((a, b) => b.distanceMeters - a.distanceMeters);
}


/**
 * 初回レイ探索の高速経路。
 *
 * 直線計算ですでにWGS84楕円体との第一候補距離が得られている場合、
 * まず被写体からその距離+安全余裕までだけを10m DEMで探索する。
 * そこで交点が得られなかった場合だけ、残りの距離を段階拡張する。
 *
 * 明示的なdistanceRange指定時と最高精度のダブルチェック時は、呼び出し側の
 * 「指定範囲をすべて調べる」という意味を変えないため従来の全範囲探索を維持する。
 * したがって最終1m精密化・round-trip検証の精度条件は一切変更しない。
 */
async function scanInitialRayTerrainIntersections(
  ray: CelestialSubjectRay,
  lensCenterHeightMeters: number,
  terrainSampler: TerrainSampler,
  signal: AbortSignal | undefined,
  distanceRange: TripodDistanceRange | undefined,
  searchProfile: TripodSearchProfile | undefined,
  preferredDistanceMeters: number | undefined,
  exhaustive: boolean
): Promise<TerrainSolution[]> {
  if (
    exhaustive ||
    distanceRange !== undefined ||
    !Number.isFinite(preferredDistanceMeters)
  ) {
    return scanRayTerrainIntersections(
      ray,
      lensCenterHeightMeters,
      terrainSampler,
      signal,
      distanceRange,
      searchProfile,
      preferredDistanceMeters
    );
  }

  const preferred = Math.min(
    ABSOLUTE_MAX_DISTANCE_METERS,
    Math.max(ABSOLUTE_MIN_DISTANCE_METERS, preferredDistanceMeters!)
  );

  // 近距離では最低1km、遠距離では第一候補の35%を余裕として持たせる。
  // ただし余裕だけで5kmを超えて広がらないよう制限する。
  // この範囲内では従来どおり全交点を返すため、途中の山稜交点も保持される。
  const safetyMarginMeters = Math.max(
    1_000,
    Math.min(5_000, preferred * 0.35)
  );
  const primaryMax = Math.min(
    ABSOLUTE_MAX_DISTANCE_METERS,
    preferred + safetyMarginMeters
  );
  const primaryRange: TripodDistanceRange = {
    minMeters: ABSOLUTE_MIN_DISTANCE_METERS,
    maxMeters: primaryMax,
  };

  const primarySolutions = await scanRayTerrainIntersections(
    ray,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    primaryRange,
    searchProfile,
    preferred
  );
  if (primarySolutions.length > 0 || primaryMax >= ABSOLUTE_MAX_DISTANCE_METERS) {
    return primarySolutions;
  }

  // 第一候補周辺で解が無かったときだけ残りを探索する。境界直上の交点を
  // 取りこぼさないよう500m重複させるが、先頭8mからの全再走査は行わない。
  const fallbackRange: TripodDistanceRange = {
    minMeters: Math.max(
      ABSOLUTE_MIN_DISTANCE_METERS,
      primaryMax - ADAPTIVE_COARSE_MAX_SPAN_METERS
    ),
    maxMeters: ABSOLUTE_MAX_DISTANCE_METERS,
  };
  return scanRayTerrainIntersections(
    ray,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    fallbackRange,
    searchProfile,
    preferred
  );
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

/**
 * 仕様3-G Round-trip検証: 候補地点を既存プレビューと同じCameraModel/
 * Projection経路（createCameraProjection → projectHorizontalToPreview、
 * celestial.ts経由でcameraModelFactory.tsを使用）へ逆投入し、天体中心と
 * 被写体中心のスクリーン座標差を測る。
 *
 * viewCorrection（現地校正用の手動視線補正）は意図的に渡さない。
 * viewCorrectionはプレビュー全体（天体・被写体の投影基底そのもの）へ
 * 均等に加算されるため、天体中心と被写体中心の「相対」位置には現れない
 * （両者が同じだけシフトし打ち消し合う）。したがってここへ混ぜると、
 * 物理的に正しい三脚座標を歪めるリスクだけが生じ、round-trip判定の
 * 意味を変えない。UI表示だけの補正と物理座標を分離するという仕様3-2の
 * 要請に従い、ここでは常にviewCorrectionなしで検証する。
 */
function verifyRoundTripProjection(
  candidatePoint: GroundPoint,
  subject: GroundPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  calculationMode: CalculationMode,
  finalHorizontal: { azimuthDegrees: number; altitudeDegrees: number }
): { dxPercent: number; dyPercent: number; inFront: boolean } | null {
  try {
    const projection = createCameraProjection(
      candidatePoint,
      subject,
      cameraSettings,
      previewAspectRatio,
      calculationMode
    );
    const screen = projectHorizontalToPreview(
      { azimuthDegrees: finalHorizontal.azimuthDegrees, altitudeDegrees: finalHorizontal.altitudeDegrees, geometricAltitudeDegrees: finalHorizontal.altitudeDegrees },
      projection
    );
    // createCameraProjectionのforwardは常に被写体方向（viewCorrectionなし）を
    // 向くよう構成されるため、被写体自身は常に画面中央(50%,50%)に投影される。
    // よって天体のスクリーン座標と中央との差が、そのまま両者のずれになる。
    return {
      dxPercent: screen.xPercent - 50,
      dyPercent: screen.yPercent - 50,
      inFront: screen.inFront,
    };
  } catch (error) {
    console.warn("[tripod-candidate] round-trip投影を計算できませんでした", error);
    return null;
  }
}

async function calculateOneCandidates(
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
  refractionWeatherResolver?: RefractionWeatherResolver,
  doubleCheckEnabled = false
): Promise<TripodCandidate[]> {
  const lensCenterHeightMeters = cameraSettings.lensCenterHeightMeters;
  if (point.altitudeDegrees <= 0.25) return [];

  // 気象連動屈折（自動モード）は約0.05度（≈5.5km）格子でキャッシュされており、
  // 三脚候補の探索範囲（通常は被写体から数百m〜数km）はほぼ必ず同じ格子内に
  // 収まる。そのため、解が収束するたびに候補地点で再取得しても得られる値は
  // 事実上変わらない。ここで被写体地点を代表点として一度だけ解決し、以降の
  // 全交点・全反復で使い回すことで、同じキャッシュ値への冗長な非同期呼び出し
  // （IndexedDB読み出し）を削減する。天体方位・高度そのものは従来どおり
  // 各反復で候補地点ごとに再計算するため、精度への影響はない。
  let activeRefractionWeather = refractionWeather;
  if (refractionWeatherResolver) {
    const resolvedWeather = await refractionWeatherResolver(subject, signal);
    abortIfRequested(signal);
    if (resolvedWeather) activeRefractionWeather = resolvedWeather;
  }

  // ダブルチェック（旧方式）専用の基準bearing。本計算のレイ探索には使わない。
  const initialBearing = (point.azimuthDegrees + 180) % 360;

  // 仕様3-C: 主計算は「天体中心→被写体→後方」のECEF 3Dレイと地形表面の
  // 交点として求める。Karney測地線bearing走査は本計算の座標生成器にしない。
  const initialRay = buildCelestialBackwardRay(subject, point.azimuthDegrees, point.altitudeDegrees);
  if (!initialRay) return [];
  const directSeedDistance = directSightlineSeedDistanceMeters(
    subject,
    point.azimuthDegrees,
    point.altitudeDegrees
  );
  const initialSolutions = await scanInitialRayTerrainIntersections(
    initialRay,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    distanceRange,
    searchProfile,
    directSeedDistance ?? searchProfile?.preferredDistanceMeters,
    doubleCheckEnabled
  );
  if (initialSolutions.length === 0) return [];

  const converged: TripodCandidate[] = [];
  for (const initialSolution of initialSolutions) {
    abortIfRequested(signal);
    let solution = initialSolution;

    // 各交点は独立に、候補地点で再計算した天体方位・高度へ最大3回だけ収束させる。
    // 全距離旧探索へは戻らず、被写体を通る同じ3Dレイ（方向だけ更新）だけを
    // 再評価する。太陽・月は近距離の観測点間で視差が無視できるため、
    // 候補地点で再計算した方位・高度を「被写体からのレイの向き」として
    // 再利用しても物理的な誤差は生じない。
    //
    // 過去に反復回数・サンプル数・探索窓を増やす変更を試したが、自作の
    // 回帰テストで効果が確認できず（同じ結果しか出なかった）、その上で
    // 実機では地形サーバーへのリクエストが増えて処理が固まる問題を
    // 引き起こしたため、根拠のない変更として撤回し元の値へ戻した。
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const candidatePoint = buildCandidateGroundPoint(
        solution.cartographic,
        subject,
        `${point.label}三脚候補`
      );
      const horizontal = calculateCelestialHorizontalCoordinates(
        point.id,
        date,
        {
          ...candidatePoint,
          height: candidatePoint.height + lensCenterHeightMeters,
          ellipsoidalHeightMeters: (candidatePoint.ellipsoidalHeightMeters ?? candidatePoint.height) + lensCenterHeightMeters,
          orthometricHeightMeters: candidatePoint.orthometricHeightMeters !== undefined
            ? candidatePoint.orthometricHeightMeters + lensCenterHeightMeters
            : undefined,
          label: `${point.label}三脚候補レンズ中心`,
        },
        calculationMode,
        activeRefractionWeather
      );
      if (horizontal.altitudeDegrees <= 0.25) break;

      const currentAltitudeError = Math.abs(
        elevationAngleDegrees(
          solution.cartographic,
          subject,
          lensCenterHeightMeters,
          calculationMode
        ) - horizontal.altitudeDegrees
      );
      const subjectBearing = calculateKarneyLineMetrics(candidatePoint, subject).bearingDegrees;
      const currentAzimuthError = angularDifferenceDegrees(subjectBearing, horizontal.azimuthDegrees);
      if (
        currentAltitudeError <= CONVERGED_HORIZONTAL_DEGREES &&
        currentAzimuthError <= CONVERGED_HORIZONTAL_DEGREES
      ) break;

      // 被写体を起点に、候補地点で再計算した最新の天体方位・高度でレイを
      // 引き直し、現在交点周辺だけを再探索する（全距離走査には戻らない）。
      const refinedRay = buildCelestialBackwardRay(subject, horizontal.azimuthDegrees, horizontal.altitudeDegrees);
      if (!refinedRay) break;
      const span = Math.max(80, solution.distanceMeters * 0.18);
      const localRange: TripodDistanceRange = {
        minMeters: Math.max(ABSOLUTE_MIN_DISTANCE_METERS, solution.distanceMeters - span),
        maxMeters: Math.min(ABSOLUTE_MAX_DISTANCE_METERS, solution.distanceMeters + span),
      };
      const localSolutions = await scanRayTerrainIntersections(
        refinedRay,
        lensCenterHeightMeters,
        terrainSampler,
        signal,
        localRange,
        {
          ...searchProfile,
          sampleCount: Math.min(20, searchProfile?.sampleCount ?? 20),
        },
        solution.distanceMeters
      );
      if (localSolutions.length === 0) break;
      solution = localSolutions.reduce((nearest, candidate) =>
        Math.abs(candidate.distanceMeters - solution.distanceMeters) <
        Math.abs(nearest.distanceMeters - solution.distanceMeters)
          ? candidate
          : nearest
      );
    }

    if (!Number.isFinite(solution.cartographic.height)) continue;

    // 画角ではなく、三脚候補の幾何学成立条件だけを最終確認する。
    // 追加DEM取得は行わず、最後に採用した候補座標で天体方位・仰角を再計算するだけ。
    const finalCandidatePoint = buildCandidateGroundPoint(
      solution.cartographic,
      subject,
      `${point.label}三脚候補最終確認`
    );
    const finalHorizontal = calculateCelestialHorizontalCoordinates(
      point.id,
      date,
      {
        ...finalCandidatePoint,
        height: finalCandidatePoint.height + lensCenterHeightMeters,
        ellipsoidalHeightMeters: (finalCandidatePoint.ellipsoidalHeightMeters ?? finalCandidatePoint.height) + lensCenterHeightMeters,
        orthometricHeightMeters: finalCandidatePoint.orthometricHeightMeters !== undefined
          ? finalCandidatePoint.orthometricHeightMeters + lensCenterHeightMeters
          : undefined,
        label: `${point.label}三脚候補レンズ中心最終確認`,
      },
      calculationMode,
      activeRefractionWeather
    );
    const finalAltitudeError = Math.abs(
      elevationAngleDegrees(
        solution.cartographic,
        subject,
        lensCenterHeightMeters,
        calculationMode
      ) - finalHorizontal.altitudeDegrees
    );
    const finalSubjectBearing = calculateKarneyLineMetrics(finalCandidatePoint, subject).bearingDegrees;
    const finalAzimuthError = angularDifferenceDegrees(finalSubjectBearing, finalHorizontal.azimuthDegrees);

    // 仕様3-G: 確定前に、既存プレビューと同じCameraModel/Projection経路へ
    // 候補地点を逆投入し、天体中心と被写体中心のスクリーン座標差を測る。
    const roundTrip = verifyRoundTripProjection(
      finalCandidatePoint,
      subject,
      cameraSettings,
      previewAspectRatio,
      calculationMode,
      finalHorizontal
    );

    // 仕様7: 診断ログ（候補座標・高さ基準・天体/被写体方位仰角・誤差・
    // スクリーンdx/dy・地形データソース）。合否に関わらず出力する。
    const diagnostics = {
      candidateLatitude: CesiumMath.toDegrees(solution.cartographic.latitude),
      candidateLongitude: CesiumMath.toDegrees(solution.cartographic.longitude),
      ellipsoidalHeightMeters: finalCandidatePoint.ellipsoidalHeightMeters,
      orthometricHeightMeters: finalCandidatePoint.orthometricHeightMeters,
      geoidHeightMeters: finalCandidatePoint.geoidHeightMeters,
      celestialAzimuthDegrees: finalHorizontal.azimuthDegrees,
      celestialAltitudeDegrees: finalHorizontal.altitudeDegrees,
      subjectAzimuthDegrees: finalSubjectBearing,
      subjectElevationDegrees: elevationAngleDegrees(
        solution.cartographic,
        subject,
        lensCenterHeightMeters,
        calculationMode
      ),
      azimuthErrorDegrees: finalAzimuthError,
      altitudeErrorDegrees: finalAltitudeError,
      previewScreenDxPercent: roundTrip?.dxPercent,
      previewScreenDyPercent: roundTrip?.dyPercent,
      terrainSource: terrainDataSource(solution.cartographic),
    };

    const roundTripFailed =
      !roundTrip ||
      !roundTrip.inFront ||
      Math.abs(roundTrip.dxPercent) > ROUND_TRIP_SCREEN_TOLERANCE_PERCENT ||
      Math.abs(roundTrip.dyPercent) > ROUND_TRIP_SCREEN_TOLERANCE_PERCENT;

    if (
      !Number.isFinite(finalHorizontal.altitudeDegrees) ||
      finalHorizontal.altitudeDegrees <= 0.25 ||
      !Number.isFinite(finalAltitudeError) ||
      !Number.isFinite(finalAzimuthError) ||
      finalAltitudeError > CONVERGED_HORIZONTAL_DEGREES ||
      finalAzimuthError > CONVERGED_HORIZONTAL_DEGREES ||
      roundTripFailed
    ) {
      console.warn(`[tripod-candidate] ${point.label}: 最終幾何収束条件（round-trip含む）を満たさない候補を除外`, {
        distanceMeters: solution.distanceMeters,
        ...diagnostics,
      });
      continue;
    }

    console.debug(`[tripod-candidate] ${point.label}: 候補確定`, {
      distanceMeters: solution.distanceMeters,
      ...diagnostics,
    });

    converged.push({
      id: point.id,
      label: point.label,
      latitude: CesiumMath.toDegrees(solution.cartographic.latitude),
      longitude: CesiumMath.toDegrees(solution.cartographic.longitude),
      height: solution.cartographic.height,
      distanceMeters: solution.distanceMeters,
      solutionType: "aligned",
    });
  }

  const unique = converged
    .filter((candidate, index, all) => all.findIndex((other) =>
      Math.abs(other.distanceMeters - candidate.distanceMeters) < 0.5
    ) === index)
    .sort((a, b) => b.distanceMeters - a.distanceMeters)
    .map((candidate, index, all) => ({
      ...candidate,
      intersectionIndex: index + 1,
      intersectionCount: all.length,
    }));

  // 旧方式はユーザーがONにした時だけ独立検算として1回実行する。
  // 本計算の候補を置換・除外しない（仕様3-H）。
  if (doubleCheckEnabled && unique.length > 0) {
    const verification = await solveTerrainDistance(
      subject,
      initialBearing,
      point.altitudeDegrees,
      lensCenterHeightMeters,
      calculationMode,
      terrainSampler,
      signal,
      distanceRange,
      undefined
    );
    abortIfRequested(signal);
    if (!verification) {
      console.warn(`[tripod-double-check] ${point.label}: 旧方式で検算解を取得できませんでした`);
    } else {
      const nearestDifference = Math.min(...unique.map((candidate) =>
        Math.abs(candidate.distanceMeters - verification.distanceMeters)
      ));
      if (nearestDifference > 1) {
        console.warn(`[tripod-double-check] ${point.label}: 本計算の最寄候補との差 ${nearestDifference.toFixed(2)}m`, {
          primary: unique.map((candidate) => candidate.distanceMeters),
          verification: verification.distanceMeters,
        });
      }
    }
  }

  return unique;
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
  refractionWeatherResolver?: RefractionWeatherResolver,
  doubleCheckEnabled = false
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
      return calculateOneCandidates(
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
        refractionWeatherResolver,
        doubleCheckEnabled
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
    result.status === "fulfilled" ? result.value : []
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
