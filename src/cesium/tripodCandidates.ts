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
import { ellipsoidalHeightMeters, withLensCenterHeight } from "../types/points";
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
import {
  fetchGsiGeoidHeightPointSpecific,
  geoidHeightMetersForTerrainSample,
  sampleWorldTerrainNeutral,
  terrainDataSource,
} from "./worldTerrain";
import {
  resetGsiElevationCacheStats,
  getGsiElevationCacheStats,
} from "./gsiElevationClient";
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
// 2026-08-26追記: 以前は「距離に比例して広がる」高さ差の許容値
// （0.12度 × 距離 × 0.05）を使っており、遠距離の候補ほど「レイに近い」と
// 判定されやすくなっていた。これは最終的な確定精度（CONVERGED_HORIZONTAL_
// DEGREES=0.002度・ROUND_TRIP_SCREEN_TOLERANCE_PERCENT=0.5%、共に距離に
// 依存しない固定基準）には一切影響しない、粗い探索段階での「交点の見逃し
// 防止」のための下準備にすぎなかった。三脚候補の確定精度は距離に関係なく
// 常に数cm単位を要求されるべきであり、この粗い探索の判定だけが「遠いから
// 緩くてよい」という誤った前提を持っていたのは筋が通っていなかったため、
// 距離に依存しない固定のメートル単位の許容値に変更する。
const ADAPTIVE_NEAR_RAY_ABSOLUTE_METERS = 6;
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

/**
 * 地形データ（DEM）の取得そのものが通信不調で軒並み失敗した場合に投げる。
 * 「本当に条件を満たす候補地点が存在しない」場合と区別するためのもの。
 * 2026-08-25追記: 以前はDEM取得が全滅していても、単に交点が見つからない
 * 場合と同じ「候補なし」という結果になり、通信起因の失敗なのか本当に
 * 候補が存在しないのかをユーザー・開発側どちらも判別できなかった。
 */
export class TerrainDataUnavailableError extends Error {
  readonly failedRatio: number;
  constructor(failedRatio: number) {
    super(
      `地形データを取得できませんでした（要求点の${Math.round(failedRatio * 100)}%が失敗）`
    );
    this.name = "TerrainDataUnavailableError";
    this.failedRatio = failedRatio;
  }
}

/**
 * 「なぜ遅いのか／なぜ候補が見つからないのか」を、コードを読んだり
 * DevToolsを開いたりせずに確認できるようにするための、直近1回分の
 * 探索診断情報。calculateTripodCandidates が呼ばれるたびに上書きされる。
 * 個人が特定できる情報は含めない（天体ラベル・件数・時間のみ）。
 */
export type TripodSearchDiagnostics = {
  startedAtMs: number;
  finishedAtMs: number | null;
  /**
   * 2026-08-26追記: 「計算中のまま何分も動かない」状態が、本当に処理が
   * 進んでいる（遅いだけ）のか、完全に停止している（デッドロック等）
   * のかを、開発者ツールを使えないインストール型アプリ環境でも判別
   * できるようにする。terrainSampler（地形取得）が呼ばれるたびに、
   * 計算完了を待たずリアルタイムで更新する。
   */
  liveRoundTripCount: number;
  liveLastRoundTripFinishedAtMs: number | null;
  /**
   * 2026-08-28追記: サーバー側のR2キャッシュ（DEMタイル単位、実際に
   * 効果のある層）が活用されているかを確認できるようにする。「地形取得
   * ◯点」という座標の総数とは別に、「そのうちタイル参照何回分で、
   * 実際にR2キャッシュが再利用されたか」を検索全体（全天体合算）で
   * 記録する。以前は「複数座標をまとめた外側のバッチキャッシュ」の
   * ヒット/ミスを見ていたが、三脚探索の性質上ほとんど意味をなさない
   * 層だったため撤去し、タイル単位の値に切り替えた。
   */
  cacheHitBatchCount: number;
  cacheMissBatchCount: number;
  cacheMemoryHitCount: number;
  cacheSharedCount: number;
  cacheBypassCount: number;
  /** 2026-08-29: 最終確定時間の実測内訳。計算結果には影響しない診断専用。 */
  totalElapsedMs: number | null;
  perCelestialBody: Record<
    string,
    {
      initialSolutionCount: number;
      convergedCount: number;
      terrainRequestedPoints: number;
      terrainFailedPoints: number;
      /**
       * 2026-08-26追記: 前回検索の距離を再利用する「距離ヒント」が
       * 実際に使われたかどうか。使われていれば探索範囲が絞り込まれ
       * 地形取得点数が少なくなるはず。使われていない場合、8m〜50kmの
       * 全距離走査になり点数が大きく増える。「なぜ点数が多いのか」を
       * 推測ではなくこの値で確定できるようにする。
       */
      distanceHintUsed: boolean;
      distanceHintMeters: number | undefined;
      /** 一次探索(狭い範囲)で解が見つからず、広い二次探索へ切り替わったか。 */
      usedWideFallbackScan: boolean;
      primaryScanMaxMeters: number | undefined;
      /** 地形取得の通信往復回数と、その累計所要時間（ミリ秒）。 */
      terrainRoundTripCount: number;
      terrainRoundTripTotalMs: number;
      /**
       * 2026-08-27追記: 通信を高速化した後も体感の遅さが残ったため、
       * 通信以外（収束反復ループの計算・精密化・ジオイド取得）に
       * かかった時間も分けて記録する。複数の交点候補がある場合は、
       * 最後に処理された候補の値で上書きされる（大まかな切り分け用途）。
       */
      initialScanMs: number;
      weatherResolveMs: number;
      convergenceLoopMs: number;
      refinementMs: number;
      doubleCheckMs: number;
      totalBodyMs: number;
      rejectionReasons: Record<string, number>;
      finalEvaluations: Array<{
        distanceMeters: number | null;
        reason: string;
        azimuthErrorDegrees: number | null;
        altitudeErrorDegrees: number | null;
        dxPercent: number | null;
        dyPercent: number | null;
        inFront: boolean | null;
      }>;
    }
  >;
};

let lastSearchDiagnostics: TripodSearchDiagnostics | null = null;

/**
 * 2026-08-26追記: scanInitialRayTerrainIntersectionsが「一次探索(狭い範囲)」
 * と「二次探索(ほぼ全距離範囲)」のどちらに落ちたかを、直近1回分だけ
 * 記録する診断用変数。天体ごとに複数回呼ばれるため、都度recordDiagnostics
 * 呼び出し時点の最新値を使う（同一天体内で複数交点があると上書きされるが、
 * 「395点のような多さの原因が二次探索の発生にあるか」の確認には十分）。
 */
let lastScanFallbackInfo: { usedFallback: boolean; primaryMaxMeters: number } | null = null;

export function getLastTripodSearchDiagnostics(): TripodSearchDiagnostics | null {
  return lastSearchDiagnostics;
}

function recordDiagnostics(
  celestialLabel: string,
  entry: TripodSearchDiagnostics["perCelestialBody"][string]
): void {
  if (!lastSearchDiagnostics) return;
  lastSearchDiagnostics.perCelestialBody[celestialLabel] = entry;
}

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
 * 重要: 方位角・高度はローカル水平座標（ENU）の値なので、異なる地点へ
 * 数値のまま移してはいけない。まず「その方位角・高度を実際に計算した
 * 観測地点」のENU基底でECEF天体方向へ変換し、そのワールド方向ベクトルを
 * 被写体位置へ平行移動して後方レイを作る。これにより、地点間でローカル
 * Up/Northが回転する地球曲率を二重に混入させない。
 *
 * origin/directionはECEF実座標（メートル単位）。directionは天体と反対側を
 * 指す単位ベクトルなので、tがそのまま被写体からの直線距離（メートル）になる。
 */
export type CelestialSubjectRay = {
  origin: Cartesian3;
  direction: Cartesian3;
};

function horizontalToEcefUnitDirection(
  observer: GroundPoint,
  azimuthDegrees: number,
  altitudeDegrees: number
): Cartesian3 | null {
  if (
    !Number.isFinite(observer.latitude) ||
    !Number.isFinite(observer.longitude) ||
    !Number.isFinite(azimuthDegrees) ||
    !Number.isFinite(altitudeDegrees)
  ) return null;

  const lat = CesiumMath.toRadians(observer.latitude);
  const lon = CesiumMath.toRadians(observer.longitude);
  const azimuth = CesiumMath.toRadians(azimuthDegrees);
  const altitude = CesiumMath.toRadians(altitudeDegrees);

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
  const horizontalScale = Math.cos(altitude);
  const direction = new Cartesian3(
    east.x * Math.sin(azimuth) * horizontalScale +
      north.x * Math.cos(azimuth) * horizontalScale +
      up.x * Math.sin(altitude),
    east.y * Math.sin(azimuth) * horizontalScale +
      north.y * Math.cos(azimuth) * horizontalScale +
      up.y * Math.sin(altitude),
    east.z * Math.sin(azimuth) * horizontalScale +
      north.z * Math.cos(azimuth) * horizontalScale +
      up.z * Math.sin(altitude)
  );
  if (!(Cartesian3.magnitudeSquared(direction) > 0)) return null;
  return Cartesian3.normalize(direction, direction);
}

export function buildCelestialBackwardRay(
  subject: GroundPoint,
  celestialAzimuthDegrees: number,
  geometricAltitudeDegrees: number,
  directionObserver: GroundPoint = subject
): CelestialSubjectRay | null {
  if (
    !Number.isFinite(subject.latitude) ||
    !Number.isFinite(subject.longitude) ||
    !Number.isFinite(ellipsoidalHeightMeters(subject))
  ) return null;

  const celestialDirection = horizontalToEcefUnitDirection(
    directionObserver,
    celestialAzimuthDegrees,
    geometricAltitudeDegrees
  );
  if (!celestialDirection) return null;

  // 三脚は天体方向の反対側にある。ローカルaz/altを被写体ENUで再構成せず、
  // 観測地点でECEF化したワールド方向をそのまま反転する。
  const direction = Cartesian3.negate(celestialDirection, new Cartesian3());
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
  geometricAltitudeDegrees: number,
  directionObserver: GroundPoint = subject
): number | null {
  if (geometricAltitudeDegrees <= 0) return null;
  const ray = buildCelestialBackwardRay(
    subject,
    celestialAzimuthDegrees,
    geometricAltitudeDegrees,
    directionObserver
  );
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
 * 地形・気象・キャッシュI/Oを開始する前に表示する概算候補を構成する。
 * WGS84楕円体との理論交点であり、精密探索の最終結果としては採用しない。
 */
export function buildPreliminaryTripodCandidates(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  lensCenterHeightMeters: number,
  initialDirectionObserver?: GroundPoint
): TripodCandidate[] {
  const rayDirectionObserver = initialDirectionObserver ?? withLensCenterHeight(
    subject,
    lensCenterHeightMeters,
    "三脚候補概算方向観測点"
  );
  return points.flatMap((point) => {
    if (!Number.isFinite(point.altitudeDegrees) || point.altitudeDegrees <= 0.25) return [];
    const geometricAltitudeDegrees = Number.isFinite(point.geometricAltitudeDegrees)
      ? (point.geometricAltitudeDegrees as number)
      : point.altitudeDegrees;
    const ray = buildCelestialBackwardRay(
      subject,
      point.azimuthDegrees,
      geometricAltitudeDegrees,
      rayDirectionObserver
    );
    const distanceMeters = directSightlineSeedDistanceMeters(
      subject,
      point.azimuthDegrees,
      geometricAltitudeDegrees,
      rayDirectionObserver
    );
    if (!ray || distanceMeters === null) return [];
    const cartographic = rayCartographicAtDistance(ray, distanceMeters);
    if (!cartographic) return [];
    const candidatePoint = buildCandidateGroundPoint(
      cartographic,
      subject,
      `${point.label}（計算中）`
    );
    return [{
      id: point.id,
      label: point.label,
      latitude: candidatePoint.latitude,
      longitude: candidatePoint.longitude,
      height: ellipsoidalHeightMeters(candidatePoint),
      distanceMeters,
      solutionType: "preliminary" as const,
    }];
  });
}

/**
 * DEMサンプルと同じ高さ基準で候補GroundPointを生成する。
 * 被写体のジオイド高は一切流用しない。GSI DEMを楕円体高へ変換した際に
 * 実際にそのサンプルへ使ったN値だけを採用する。
 */
export function buildCandidateGroundPoint(
  cartographic: Cartographic,
  _subject: GroundPoint,
  label: string
): GroundPoint {
  const ellipsoidal = cartographic.height;
  const geoid = geoidHeightMetersForTerrainSample(cartographic);
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

/**
 * 最終候補では候補座標自身のGSIジオイド高Nを取得してH/N/hを再構成する。
 * 交点探索時に地域Nを使ったGSI DEMサンプルならHをその値から復元し、
 * 地点固有Nへ差し替えて楕円体高hを更新する。別地点のNは使用しない。
 */
async function buildPointSpecificFinalCandidateGroundPoint(
  cartographic: Cartographic,
  subject: GroundPoint,
  label: string,
  signal?: AbortSignal
): Promise<GroundPoint> {
  const base = buildCandidateGroundPoint(cartographic, subject, label);
  const exactGeoid = await fetchGsiGeoidHeightPointSpecific(cartographic, signal);
  const sampledGeoid = geoidHeightMetersForTerrainSample(cartographic);
  const orthometric = Number.isFinite(sampledGeoid)
    ? cartographic.height - (sampledGeoid as number)
    : cartographic.height - exactGeoid;
  const ellipsoidal = orthometric + exactGeoid;
  return {
    ...base,
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: orthometric,
    geoidHeightMeters: exactGeoid,
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
    const nearRay = Math.min(Math.abs(previous), Math.abs(current)) <= ADAPTIVE_NEAR_RAY_ABSOLUTE_METERS;
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
    lastScanFallbackInfo = { usedFallback: false, primaryMaxMeters: primaryMax };
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
  // 2026-08-26追記: 診断用。一次探索（seed±余裕の狭い範囲）で解が
  // 見つからず、この広い二次探索（ほぼ8m〜50km全域）に落ちたことを記録
  // する。地形取得点数が多い（実機で395点）原因が、この二次探索への
  // 分岐にあるのかを確定するため。
  lastScanFallbackInfo = { usedFallback: true, primaryMaxMeters: primaryMax };
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



type ManualEquivalentEvaluation = {
  candidatePoint: GroundPoint;
  horizontal: { azimuthDegrees: number; altitudeDegrees: number; geometricAltitudeDegrees?: number };
  roundTrip: { dxPercent: number; dyPercent: number; inFront: boolean };
  score: number;
  distanceMeters: number;
};

/**
 * 手動三脚ピンと同じ最終評価経路。
 * 地点が決まった後は、地表高→任意カメラ高→天体水平座標→CameraModel投影
 * という通常プレビューと同じ順で評価し、天体中心と被写体中心の画面誤差を返す。
 * ECEFレイや0.002度の角度収束値はここでは正解判定に使わない。
 */
function evaluateManualEquivalentCandidate(
  candidatePoint: GroundPoint,
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  date: Date,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): ManualEquivalentEvaluation | null {
  const lensObserver = withLensCenterHeight(
    candidatePoint,
    cameraSettings.lensCenterHeightMeters,
    `${point.label}詳細探索レンズ中心`
  );
  const horizontal = calculateCelestialHorizontalCoordinates(
    point.id,
    date,
    lensObserver,
    calculationMode,
    refractionWeather
  );
  if (!Number.isFinite(horizontal.altitudeDegrees) || horizontal.altitudeDegrees <= 0.25) {
    return null;
  }
  const roundTrip = verifyRoundTripProjection(
    candidatePoint,
    subject,
    cameraSettings,
    previewAspectRatio,
    calculationMode,
    horizontal
  );
  if (!roundTrip || !roundTrip.inFront || !Number.isFinite(roundTrip.dxPercent) || !Number.isFinite(roundTrip.dyPercent)) {
    return null;
  }
  const distanceMeters = calculateKarneyLineMetrics(subject, candidatePoint).distanceMeters;
  return {
    candidatePoint,
    horizontal,
    roundTrip,
    score: Math.hypot(roundTrip.dxPercent, roundTrip.dyPercent),
    distanceMeters,
  };
}

/**
 * 二段階方式の詳細側。粗いECEF+DEM解の近傍だけを、手動三脚ピンと同じ
 * CameraModel評価で適応的に絞る。1回9点×最大3回=最大27点。
 * 粗探索は位置のseedにのみ使い、最終的な正解は画面中心誤差で決める。
 */
async function refineWithManualEquivalentProjection(
  coarseCartographic: Cartographic,
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  date: Date,
  calculationMode: CalculationMode,
  terrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange,
  refractionWeather?: RefractionWeatherContext
): Promise<ManualEquivalentEvaluation | null> {
  const coarsePoint = buildCandidateGroundPoint(
    coarseCartographic,
    subject,
    `${point.label}粗候補`
  );
  const coarseMetrics = calculateKarneyLineMetrics(subject, coarsePoint);
  if (!(coarseMetrics.distanceMeters > 0) || !Number.isFinite(coarseMetrics.bearingDegrees)) {
    return null;
  }

  const minimum = Math.max(
    ABSOLUTE_MIN_DISTANCE_METERS,
    distanceRange?.minMeters ?? ABSOLUTE_MIN_DISTANCE_METERS
  );
  const maximum = Math.min(
    ABSOLUTE_MAX_DISTANCE_METERS,
    distanceRange?.maxMeters ?? ABSOLUTE_MAX_DISTANCE_METERS
  );

  // 2026-08-29 regression repair:
  // The previous manual-equivalent refinement searched only along ONE fixed bearing
  // (coarseMetrics.bearingDegrees). That can minimize distance error but cannot correct
  // a lateral error in the coarse ECEF/DEM intersection. Because final acceptance is a
  // 2-D CameraModel screen error (dx AND dy), a 1-D distance-only optimizer can leave
  // every real intersection outside the 0.5% round-trip gate even when valid terrain
  // intersections exist. Keep the exact same CameraModel objective and acceptance gate,
  // but solve the missing second degree of freedom: bearing/lateral displacement.
  let centerDistance = Math.min(maximum, Math.max(minimum, coarseMetrics.distanceMeters));
  let centerBearing = coarseMetrics.bearingDegrees;
  let radialRadiusMeters = Math.max(24, Math.min(80, centerDistance * 0.04));
  let lateralRadiusMeters = radialRadiusMeters;
  let best: ManualEquivalentEvaluation | null = null;

  for (let pass = 0; pass < 3; pass += 1) {
    abortIfRequested(signal);
    const segments = 8;
    const requests: Array<{ distance: number; bearing: number; cartographic: Cartographic }> = [];
    const dedupe = new Set<string>();

    for (let radialIndex = 0; radialIndex <= segments; radialIndex += 1) {
      const rawDistance = centerDistance - radialRadiusMeters +
        (2 * radialRadiusMeters * radialIndex) / segments;
      const distance = Math.min(maximum, Math.max(minimum, rawDistance));
      for (let lateralIndex = 0; lateralIndex <= segments; lateralIndex += 1) {
        const lateralMeters = -lateralRadiusMeters +
          (2 * lateralRadiusMeters * lateralIndex) / segments;
        // Convert the requested cross-track displacement to a bearing offset without
        // quantizing coordinates. atan2 is stable even at the minimum 8 m range.
        const bearingOffsetDegrees = Math.atan2(lateralMeters, Math.max(distance, 1)) * 180 / Math.PI;
        const bearing = (centerBearing + bearingOffsetDegrees + 360) % 360;
        const key = `${distance.toFixed(9)}:${bearing.toFixed(12)}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        requests.push({
          distance,
          bearing,
          cartographic: destinationCartographic(subject, bearing, distance),
        });
      }
    }

    const sampled = await terrainSampler(
      requests.map((request) => request.cartographic),
      signal,
      "1m"
    );
    abortIfRequested(signal);

    let passBest: ManualEquivalentEvaluation | null = null;
    for (let index = 0; index < sampled.length; index += 1) {
      const cartographic = sampled[index];
      if (!cartographic || !Number.isFinite(cartographic.height)) continue;
      const candidate = buildCandidateGroundPoint(
        cartographic,
        subject,
        `${point.label}手動三脚ピン同等2D詳細候補`
      );
      const evaluated = evaluateManualEquivalentCandidate(
        candidate,
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        refractionWeather
      );
      if (!evaluated) continue;
      if (!passBest || evaluated.score < passBest.score) passBest = evaluated;
      if (!best || evaluated.score < best.score) best = evaluated;
    }
    if (!passBest) break;

    const passMetrics = calculateKarneyLineMetrics(subject, passBest.candidatePoint);
    centerDistance = Math.min(maximum, Math.max(minimum, passMetrics.distanceMeters));
    centerBearing = passMetrics.bearingDegrees;
    // One grid spacing from the preceding pass becomes the next search radius.
    radialRadiusMeters = Math.max(0.5, (2 * radialRadiusMeters) / segments);
    lateralRadiusMeters = Math.max(0.5, (2 * lateralRadiusMeters) / segments);
  }

  if (!best) return null;

  const bestCartographic = Cartographic.fromDegrees(
    best.candidatePoint.longitude,
    best.candidatePoint.latitude,
    ellipsoidalHeightMeters(best.candidatePoint)
  );
  const exactPoint = await buildPointSpecificFinalCandidateGroundPoint(
    bestCartographic,
    subject,
    `${point.label}手動三脚ピン同等最終候補`,
    signal
  );
  abortIfRequested(signal);
  return evaluateManualEquivalentCandidate(
    exactPoint,
    subject,
    point,
    cameraSettings,
    previewAspectRatio,
    date,
    calculationMode,
    refractionWeather
  );
}

async function calculateOneCandidates(
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  previewAspectRatio: number,
  date: Date,
  calculationMode: CalculationMode,
  outerTerrainSampler: TerrainSampler,
  signal?: AbortSignal,
  distanceRange?: TripodDistanceRange,
  searchProfile?: TripodSearchProfile,
  refractionWeather?: RefractionWeatherContext,
  refractionWeatherResolver?: RefractionWeatherResolver,
  doubleCheckEnabled = false,
  initialDirectionObserver?: GroundPoint,
  onPreliminaryCandidate?: (candidate: TripodCandidate) => void
): Promise<TripodCandidate[]> {
  const lensCenterHeightMeters = cameraSettings.lensCenterHeightMeters;
  if (point.altitudeDegrees <= 0.25) return [];

  // この天体単独の地形取得成否を集計する（診断表示用）。外側の
  // outerTerrainSampler（instrumentedTerrainSampler）が担う全天体合算の
  // 集計とは別に、天体ごとの内訳を得るためにここでもう一段ラップする。
  let terrainRequestedCount = 0;
  let terrainFailedCount = 0;
  // 2026-08-26追記: 「地形取得◯点」は送った座標の総数であり、通信の
  // 往復回数（terrainSamplerの呼び出し回数）とは別物。点数が多くても
  // 少ない往復回数にまとまっていれば精度を保ったまま遅くない設計と
  // 言えるため、往復回数と累計所要時間も分けて記録し、遅さの本当の
  // 原因（点数が多いのか、往復回数が多いのか）を切り分けられるようにする。
  let terrainRoundTripCount = 0;
  let terrainRoundTripTotalMs = 0;
  // 2026-08-27追記: 通信以外（収束反復ループ・精密化・ジオイド取得）に
  // かかった時間。processInitialSolution内で更新される。
  let convergenceLoopTotalMs = 0;
  let refinementTotalMs = 0;
  let initialScanMs = 0;
  let weatherResolveMs = 0;
  let doubleCheckMs = 0;
  const bodyStartedAt = performance.now();
  const rejectionReasons: Record<string, number> = {};
  const finalEvaluations: TripodSearchDiagnostics["perCelestialBody"][string]["finalEvaluations"] = [];
  const reject = (reason: string, evaluation?: Partial<TripodSearchDiagnostics["perCelestialBody"][string]["finalEvaluations"][number]>) => {
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    finalEvaluations.push({
      distanceMeters: evaluation?.distanceMeters ?? null,
      reason,
      azimuthErrorDegrees: evaluation?.azimuthErrorDegrees ?? null,
      altitudeErrorDegrees: evaluation?.altitudeErrorDegrees ?? null,
      dxPercent: evaluation?.dxPercent ?? null,
      dyPercent: evaluation?.dyPercent ?? null,
      inFront: evaluation?.inFront ?? null,
    });
  };
  const terrainSampler: TerrainSampler = async (samplePoints, sampleSignal, maximumDetail) => {
    const startedAt = performance.now();
    const result = await outerTerrainSampler(samplePoints, sampleSignal, maximumDetail);
    terrainRoundTripCount += 1;
    terrainRoundTripTotalMs += performance.now() - startedAt;
    terrainRequestedCount += result.length;
    terrainFailedCount += result.filter(
      (sample) => !sample || !Number.isFinite(sample.height)
    ).length;
    return result;
  };

  // 気象連動屈折（自動モード）は約0.05度（≈5.5km）格子でキャッシュされており、
  // 三脚候補の探索範囲（通常は被写体から数百m〜数km）はほぼ必ず同じ格子内に
  // 収まる。そのため、解が収束するたびに候補地点で再取得しても得られる値は
  // 事実上変わらない。ここで被写体地点を代表点として一度だけ解決し、以降の
  // 全交点・全反復で使い回すことで、同じキャッシュ値への冗長な非同期呼び出し
  // （IndexedDB読み出し）を削減する。天体方位・高度そのものは従来どおり
  // 各反復で候補地点ごとに再計算するため、精度への影響はない。
  let activeRefractionWeather = refractionWeather;
  // ダブルチェック（旧方式）専用の基準bearing。本計算のレイ探索には使わない。
  const initialBearing = (point.azimuthDegrees + 180) % 360;

  // 仕様3-C: 主計算は「天体中心→被写体→後方」のECEF 3Dレイと地形表面の
  // 交点として求める。pointのaz/altを計算した観測地点のENUでECEF化してから
  // 被写体へ平行移動する。観測地点が不明な検索経路だけ被写体地点を使う。
  const rayDirectionObserver = initialDirectionObserver ?? withLensCenterHeight(
    subject,
    lensCenterHeightMeters,
    `${point.label}初期方向観測点`
  );
  // ECEFレイは幾何直線なので、天体計算が既に返している幾何高度を直接使う。
  // 見かけ天体高度から「地上物体の屈折量」を差し引くのは物理的に別の補正を
  // 混同するため禁止する。geometricAltitudeDegrees が無い互換入力だけ apparent を
  // 使用し、通常の太陽/月/天の川計算では必ず幾何高度が使われる。
  const initialGeometricRayAltitudeDegrees =
    Number.isFinite(point.geometricAltitudeDegrees)
      ? (point.geometricAltitudeDegrees as number)
      : point.altitudeDegrees;

  const initialRay = buildCelestialBackwardRay(
    subject,
    point.azimuthDegrees,
    initialGeometricRayAltitudeDegrees,
    rayDirectionObserver
  );
  if (!initialRay) return [];
  const directSeedDistance = directSightlineSeedDistanceMeters(
    subject,
    point.azimuthDegrees,
    initialGeometricRayAltitudeDegrees,
    rayDirectionObserver
  );
  // 2026-08-28追記: 地形（建物・山などの凹凸）を確認する精密計算には
  // 通信を伴い数秒〜数十秒かかるため、それを待つ前に、通信を一切使わない
  // 理論値（地球を完全な球体とみなした場合の交点）を「候補点計算中」として
  // 先に表示できるよう、判明した時点でコールバックする。最終的な精密な
  // 結果が出たら、この暫定値は呼び出し元で確定候補に置き換えられる
  // （精度・最終結果には一切影響しない、表示のタイミングだけの変更）。
  if (onPreliminaryCandidate && directSeedDistance !== null) {
    const [preliminary] = buildPreliminaryTripodCandidates(
      subject,
      [point],
      lensCenterHeightMeters,
      rayDirectionObserver
    );
    if (preliminary) onPreliminaryCandidate(preliminary);
  }

  // 暫定候補は気象・地形I/Oを一切待たずに通知する。気象コンテキストは
  // ここから先の精密探索では従来どおり必ず解決して使用するため、最終候補の
  // 計算値・採否は変わらない。自動気象APIが遅い場合にも地図表示だけは止めない。
  if (refractionWeatherResolver) {
    const weatherStartedAt = performance.now();
    const resolvedWeather = await refractionWeatherResolver(subject, signal);
    weatherResolveMs += performance.now() - weatherStartedAt;
    abortIfRequested(signal);
    if (resolvedWeather) activeRefractionWeather = resolvedWeather;
  }
  // 2026-08-27追記: 「実際に地面を確認して見つかった、前回の確かな
  // 答え」（searchProfile.preferredDistanceMeters）よりも、「地面を
  // 一切見ていない、机上の幾何学的な見積もり」（directSeedDistance）が
  // 優先される構造になっていた。directSeedDistanceは高度が正であれば
  // ほぼ常に何らかの値を返すため、結果として前回の確かな答えが実質的に
  // 一度も使われていなかった。被写体が変わっていない場合の距離ヒントは
  // App.tsx側で「同一被写体か」を確認した上でのみ渡されるため信頼でき、
  // 優先すべきなのはこちらである。仮にヒントが外れていても、一次探索の
  // 範囲を超えた場合は自動的に全距離走査へフォールバックする安全弁が
  // 既にあるため、優先順位を入れ替えても精度・安全性は変わらない。
  const effectiveSeedDistance = searchProfile?.preferredDistanceMeters ?? directSeedDistance ?? undefined;
  const seedDistanceSource: "direct-geometric" | "preferred-hint" | "none" =
    searchProfile?.preferredDistanceMeters !== undefined
      ? "preferred-hint"
      : directSeedDistance !== null
        ? "direct-geometric"
        : "none";
  const initialScanStartedAt = performance.now();
  const initialSolutions = await scanInitialRayTerrainIntersections(
    initialRay,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    distanceRange,
    searchProfile,
    effectiveSeedDistance,
    doubleCheckEnabled
  );
  initialScanMs += performance.now() - initialScanStartedAt;
  if (initialSolutions.length === 0) {
    recordDiagnostics(point.label, {
      initialSolutionCount: 0,
      convergedCount: 0,
      terrainRequestedPoints: terrainRequestedCount,
      terrainFailedPoints: terrainFailedCount,
      distanceHintUsed: seedDistanceSource === "preferred-hint",
      distanceHintMeters: effectiveSeedDistance,
      usedWideFallbackScan: lastScanFallbackInfo?.usedFallback ?? false,
      primaryScanMaxMeters: lastScanFallbackInfo?.primaryMaxMeters,
      terrainRoundTripCount,
      terrainRoundTripTotalMs,
      initialScanMs,
      weatherResolveMs,
      convergenceLoopMs: convergenceLoopTotalMs,
      refinementMs: refinementTotalMs,
      doubleCheckMs,
      totalBodyMs: performance.now() - bodyStartedAt,
      rejectionReasons,
      finalEvaluations,
    });
    return [];
  }

  // 2026-08-25追記: 見つかった交点候補（initialSolutions）が複数ある場合、
  // 以前はここから先の処理（収束反復＋詳細探索、交点ごとに合計最大6回程度の
  // 通信）を1つずつ直列に処理していた。各交点の計算は互いに独立しており、
  // 前の交点の結果を次の交点の計算に使うことはないため、Promise.allSettledで
  // 並列化しても結果は変わらない。これにより「候補が複数見つかる場所ほど、
  // その数に比例して待たされる」という体感速度の問題を、通信回数自体は
  // 変えずに改善する（過去に撤回した変更は反復回数やサンプル数を"増やす"もの
  // だったため、ここでの"直列を並列にするだけ"の変更とは性質が異なる）。
  const convergedResults = await Promise.allSettled(
    initialSolutions.map((initialSolution) =>
      processInitialSolution(initialSolution)
    )
  );
  const converged: TripodCandidate[] = [];
  for (const result of convergedResults) {
    if (result.status === "fulfilled" && result.value) {
      converged.push(result.value);
    } else if (result.status === "rejected") {
      if (isAbortError(result.reason)) throw result.reason;
      console.warn(`[tripod-candidate] ${point.label}: 交点候補の処理に失敗`, result.reason);
    }
  }

  async function processInitialSolution(
    initialSolution: TerrainSolution
  ): Promise<TripodCandidate | null> {
    abortIfRequested(signal);
    let solution = initialSolution;
    // 2026-08-27追記: 地形通信自体は高速化できたが、依然として体感の
    // 遅さが残っていたため、通信以外（収束反復ループの計算・
    // refineWithManualEquivalentProjection・ジオイド取得）にかかる時間を
    // 分けて計測し、「謎の時間」の所在を特定できるようにする。
    const convergenceLoopStartedAt = performance.now();

    // 各交点は独立に、候補地点で再計算した天体方位・高度へ最大3回だけ収束させる。
    // 全距離旧探索へは戻らない。重要なのは、候補地点のaz/altを被写体地点の
    // ENUへ数値のまま移さず、候補地点自身のENUでECEF方向へ変換した後に
    // 被写体を通る平行レイとして再評価すること。
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
      const candidateLensObserver = withLensCenterHeight(
        candidatePoint,
        lensCenterHeightMeters,
        `${point.label}三脚候補レンズ中心`
      );
      const horizontal = calculateCelestialHorizontalCoordinates(
        point.id,
        date,
        candidateLensObserver,
        calculationMode,
        activeRefractionWeather
      );
      if (horizontal.altitudeDegrees <= 0.25) break;

      const candidateSubjectElevation = computeApparentElevation(
        candidateLensObserver,
        subject,
        calculationMode
      );
      const currentAltitudeError = Math.abs(
        candidateSubjectElevation.apparentAltitudeDegrees - horizontal.altitudeDegrees
      );
      const subjectBearing = calculateKarneyLineMetrics(candidatePoint, subject).bearingDegrees;
      const currentAzimuthError = angularDifferenceDegrees(subjectBearing, horizontal.azimuthDegrees);
      if (
        currentAltitudeError <= CONVERGED_HORIZONTAL_DEGREES &&
        currentAzimuthError <= CONVERGED_HORIZONTAL_DEGREES
      ) break;

      // 被写体を起点に、候補地点自身のENUで求めた最新の天体ECEF方向へ
      // レイを引き直す。ECEFレイは幾何直線なので天体の幾何高度を直接使用する。
      const geometricRayAltitudeDegrees =
        Number.isFinite(horizontal.geometricAltitudeDegrees)
          ? (horizontal.geometricAltitudeDegrees as number)
          : horizontal.altitudeDegrees;
      const refinedRay = buildCelestialBackwardRay(
        subject,
        horizontal.azimuthDegrees,
        geometricRayAltitudeDegrees,
        candidateLensObserver
      );
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

    if (!Number.isFinite(solution.cartographic.height)) {
      reject("solution-height-invalid", { distanceMeters: solution.distanceMeters });
      return null;
    }
    const convergenceLoopMs = performance.now() - convergenceLoopStartedAt;
    convergenceLoopTotalMs += convergenceLoopMs;

    // 粗いECEF+DEM解はseedとしてのみ使用する。ここから先は、粗候補周辺だけを
    // 手動三脚ピンと同じ「地表高→任意カメラ高→天体計算→CameraModel」経路で
    // 詳細探索し、画面中心誤差が最小の地点を正解候補とする。
    const refinementStartedAt = performance.now();
    let manualRefined: ManualEquivalentEvaluation | null;
    try {
      manualRefined = await refineWithManualEquivalentProjection(
        solution.cartographic,
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        terrainSampler,
        signal,
        distanceRange,
        activeRefractionWeather
      );
    } catch (error) {
      reject("manual-refinement-exception", { distanceMeters: solution.distanceMeters });
      console.warn(`[tripod-candidate] ${point.label}: 手動三脚ピン同等の詳細探索に失敗`, error);
      return null;
    }
    const refinementMs = performance.now() - refinementStartedAt;
    refinementTotalMs += refinementMs;
    if (!manualRefined) {
      reject("manual-refinement-no-valid-evaluation", { distanceMeters: solution.distanceMeters });
      return null;
    }

    const finalCandidatePoint = manualRefined.candidatePoint;
    const finalHorizontal = manualRefined.horizontal;
    const roundTrip = manualRefined.roundTrip;
    const finalCartographic = Cartographic.fromDegrees(
      finalCandidatePoint.longitude,
      finalCandidatePoint.latitude,
      ellipsoidalHeightMeters(finalCandidatePoint)
    );
    const finalAltitudeError = Math.abs(
      elevationAngleDegrees(
        finalCartographic,
        subject,
        lensCenterHeightMeters,
        calculationMode
      ) - finalHorizontal.altitudeDegrees
    );
    const finalSubjectBearing = calculateKarneyLineMetrics(finalCandidatePoint, subject).bearingDegrees;
    const finalAzimuthError = angularDifferenceDegrees(finalSubjectBearing, finalHorizontal.azimuthDegrees);

    // 仕様7: 診断ログ（候補座標・高さ基準・天体/被写体方位仰角・誤差・
    // スクリーンdx/dy・地形データソース）。合否に関わらず出力する。
    const diagnostics = {
      candidateLatitude: finalCandidatePoint.latitude,
      candidateLongitude: finalCandidatePoint.longitude,
      ellipsoidalHeightMeters: finalCandidatePoint.ellipsoidalHeightMeters,
      orthometricHeightMeters: finalCandidatePoint.orthometricHeightMeters,
      geoidHeightMeters: finalCandidatePoint.geoidHeightMeters,
      celestialAzimuthDegrees: finalHorizontal.azimuthDegrees,
      celestialAltitudeDegrees: finalHorizontal.altitudeDegrees,
      subjectAzimuthDegrees: finalSubjectBearing,
      subjectElevationDegrees: elevationAngleDegrees(
        finalCartographic,
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
      roundTripFailed
    ) {
      const rejectionReason = !Number.isFinite(finalHorizontal.altitudeDegrees)
        ? "final-celestial-altitude-invalid"
        : finalHorizontal.altitudeDegrees <= 0.25
          ? "final-celestial-below-threshold"
          : !Number.isFinite(finalAltitudeError)
            ? "final-altitude-error-invalid"
            : !Number.isFinite(finalAzimuthError)
              ? "final-azimuth-error-invalid"
              : !roundTrip
                ? "roundtrip-missing"
                : !roundTrip.inFront
                  ? "roundtrip-behind-camera"
                  : Math.abs(roundTrip.dxPercent) > ROUND_TRIP_SCREEN_TOLERANCE_PERCENT
                    ? "roundtrip-horizontal-outside-tolerance"
                    : "roundtrip-vertical-outside-tolerance";
      reject(rejectionReason, {
        distanceMeters: manualRefined.distanceMeters,
        azimuthErrorDegrees: Number.isFinite(finalAzimuthError) ? finalAzimuthError : null,
        altitudeErrorDegrees: Number.isFinite(finalAltitudeError) ? finalAltitudeError : null,
        dxPercent: roundTrip && Number.isFinite(roundTrip.dxPercent) ? roundTrip.dxPercent : null,
        dyPercent: roundTrip && Number.isFinite(roundTrip.dyPercent) ? roundTrip.dyPercent : null,
        inFront: roundTrip?.inFront ?? null,
      });
      console.warn(`[tripod-candidate] ${point.label}: 最終幾何収束条件（round-trip含む）を満たさない候補を除外`, {
        distanceMeters: manualRefined.distanceMeters,
        ...diagnostics,
      });
      return null;
    }

    return {
      id: point.id,
      label: point.label,
      latitude: finalCandidatePoint.latitude,
      longitude: finalCandidatePoint.longitude,
      height: ellipsoidalHeightMeters(finalCandidatePoint),
      distanceMeters: manualRefined.distanceMeters,
      solutionType: "aligned",
    };
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
    const doubleCheckStartedAt = performance.now();
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
    doubleCheckMs += performance.now() - doubleCheckStartedAt;
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

  recordDiagnostics(point.label, {
    initialSolutionCount: initialSolutions.length,
    convergedCount: unique.length,
    terrainRequestedPoints: terrainRequestedCount,
    terrainFailedPoints: terrainFailedCount,
    distanceHintUsed: seedDistanceSource === "preferred-hint",
    distanceHintMeters: effectiveSeedDistance,
    usedWideFallbackScan: lastScanFallbackInfo?.usedFallback ?? false,
    primaryScanMaxMeters: lastScanFallbackInfo?.primaryMaxMeters,
    terrainRoundTripCount,
    terrainRoundTripTotalMs,
    initialScanMs,
    weatherResolveMs,
    convergenceLoopMs: convergenceLoopTotalMs,
    refinementMs: refinementTotalMs,
    doubleCheckMs,
    totalBodyMs: performance.now() - bodyStartedAt,
    rejectionReasons,
    finalEvaluations,
  });
  return unique;
}

export async function calculateTripodCandidates(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  cameraSettingsOrLensHeight: CameraSettings | number,
  date: Date,
  calculationMode: CalculationMode,
  terrainSampler: TerrainSampler = sampleWorldTerrainNeutral,
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
  doubleCheckEnabled = false,
  initialDirectionObserver?: GroundPoint,
  /**
   * 2026-08-28追記: 精密計算（数秒〜数十秒）が終わる前に、通信不要の
   * 理論値を「候補点計算中」として先に表示できるよう、天体ごとに
   * 判明した時点で呼び出す。最終結果には一切影響しない。
   */
  onPreliminaryCandidate?: (candidate: TripodCandidate) => void,
  /**
   * 天体1件の精密探索が完了した時点で、その天体の確定候補を通知する。
   * 全天体のPromise.allSettled完了を待たずに表示するための通知専用で、
   * 戻り値・探索順・精度条件には影響しない。
   */
  onCelestialCandidatesResolved?: (
    id: CelestialScreenPoint["id"],
    candidates: TripodCandidate[]
  ) => void
): Promise<TripodCandidate[]> {
  const cameraSettings: CameraSettings = typeof cameraSettingsOrLensHeight === "number"
    ? {
        focalLengthMm: 24,
        lensCenterHeightMeters: cameraSettingsOrLensHeight,
      }
    : cameraSettingsOrLensHeight;
  abortIfRequested(signal);

  resetGsiElevationCacheStats();
  lastSearchDiagnostics = {
    startedAtMs: Date.now(),
    finishedAtMs: null,
    liveRoundTripCount: 0,
    liveLastRoundTripFinishedAtMs: null,
    cacheHitBatchCount: 0,
    cacheMissBatchCount: 0,
    cacheMemoryHitCount: 0,
    cacheSharedCount: 0,
    cacheBypassCount: 0,
    totalElapsedMs: null,
    perCelestialBody: {},
  };

  // 地形データ取得の成否を集計するラッパー。既存のterrainSamplerの
  // 挙動・戻り値は一切変えず、通過した点数と、高さが取得できなかった
  // （NaN/未定義になった）点数だけを数える。
  let terrainRequestedCount = 0;
  let terrainFailedCount = 0;
  const instrumentedTerrainSampler: TerrainSampler = async (samplePoints, sampleSignal, maximumDetail) => {
    const result = await terrainSampler(samplePoints, sampleSignal, maximumDetail);
    // 2026-08-26追記: 計算完了を待たずリアルタイムで更新する（進行中
    // 表示用）。天体ごとの内訳（recordDiagnostics）とは別に、全体の
    // 「最後にいつ通信が完了したか」を常に最新化する。
    if (lastSearchDiagnostics) {
      lastSearchDiagnostics.liveRoundTripCount += 1;
      lastSearchDiagnostics.liveLastRoundTripFinishedAtMs = Date.now();
    }
    terrainRequestedCount += result.length;
    terrainFailedCount += result.filter(
      (sample) => !sample || !Number.isFinite(sample.height)
    ).length;
    return result;
  };

  // 太陽・月に限定すると、同じ候補計算を共有する天の川・北極星が
  // アプリ全体から消えるため、地平線上にある有効な天体をすべて対象にする。
  const visiblePoints = points.filter(
    (point) => Number.isFinite(point.altitudeDegrees) && point.altitudeDegrees > 0.25
  );

  // 精度優先: DEM取得失敗時に被写体高度で代用しない。
  // 高度基準が不明な候補は確定結果へ含めず、取得エラーを呼び出し側へ返す。


  const results = await Promise.allSettled(
    visiblePoints.map(async (point) => {
      const preferredDistanceMeters = preferredDistancesById?.[point.id];
      const pointSearchProfile: TripodSearchProfile | undefined =
        preferredDistanceMeters !== undefined
          ? { ...searchProfile, preferredDistanceMeters }
          : searchProfile;
      const candidates = await calculateOneCandidates(
        subject,
        point,
        cameraSettings,
        previewAspectRatio,
        date,
        calculationMode,
        instrumentedTerrainSampler,
        signal,
        distanceRange,
        pointSearchProfile,
        refractionWeather,
        refractionWeatherResolver,
        doubleCheckEnabled,
        initialDirectionObserver,
        onPreliminaryCandidate
      );
      if (onCelestialCandidatesResolved) {
        try {
          onCelestialCandidatesResolved(point.id, candidates);
        } catch (error) {
          // 表示通知の失敗で精密計算そのものを失敗扱いにしない。
          console.warn(`[tripod-candidate] ${point.label}: 途中結果を表示できませんでした`, error);
        }
      }
      return candidates;
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

  // 2026-08-25追記: 上のチェックは「例外が投げられた」場合しか拾えない。
  // しかしDEM取得が失敗すると、多くの経路は例外を投げず「高さがNaNの
  // サンプル」として静かに処理を続け、最終的に交点が見つからず候補0件に
  // なる（＝「本当に候補が存在しない」場合と見分けがつかない）。
  // 要求した地形サンプルの半分以上が失敗していて、かつ候補が1件も
  // 得られなかった場合は、通信起因の失敗である可能性が高いとみなし、
  // 呼び出し側（App.tsx）が「候補なし」ではなく「通信エラー」として
  // 案内できるよう区別する。
  const TERRAIN_FAILURE_RATIO_THRESHOLD = 0.5;
  const finalizeDiagnostics = () => {
    if (!lastSearchDiagnostics) return;
    lastSearchDiagnostics.finishedAtMs = Date.now();
    lastSearchDiagnostics.totalElapsedMs =
      lastSearchDiagnostics.finishedAtMs - lastSearchDiagnostics.startedAtMs;
    const cacheStats = getGsiElevationCacheStats();
    lastSearchDiagnostics.cacheHitBatchCount = cacheStats.hit;
    lastSearchDiagnostics.cacheMissBatchCount = cacheStats.miss;
    lastSearchDiagnostics.cacheMemoryHitCount = cacheStats.memoryHit;
    lastSearchDiagnostics.cacheSharedCount = cacheStats.shared;
    lastSearchDiagnostics.cacheBypassCount = cacheStats.bypass;
  };
  if (
    candidates.length === 0 &&
    terrainRequestedCount > 0 &&
    terrainFailedCount / terrainRequestedCount >= TERRAIN_FAILURE_RATIO_THRESHOLD
  ) {
    finalizeDiagnostics();
    throw new TerrainDataUnavailableError(terrainFailedCount / terrainRequestedCount);
  }

  finalizeDiagnostics();
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
  terrainSampler: TerrainSampler = sampleWorldTerrainNeutral,
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
