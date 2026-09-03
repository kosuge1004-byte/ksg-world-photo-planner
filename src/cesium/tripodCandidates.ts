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
import { ellipsoidalHeightMeters, orthometricHeightMeters, withLensCenterHeight } from "../types/points";
import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import {
  calculateCelestialHorizontalCoordinates,
} from "./celestial";
import {
  calculateKarneyDestinationPoint,
  calculateKarneyLineMetrics,
} from "../geodesy/karneyGeodesic";
import {
  fetchGsiGeoidHeightPointSpecific,
  geoidHeightMetersForTerrainSample,
  sampleWorldTerrain,
} from "./worldTerrain";
import {
  resetGsiElevationCacheStats,
  getGsiElevationCacheStats,
} from "./gsiElevationClient";
import {
  resetLocalTileCacheStats,
  getLocalTileCacheStats,
} from "./gsiDemTileCache";
import { computeApparentElevation } from "../apparent/apparentElevation";
import { calculateGeometricElevation } from "./geometry";
import {
  EARTH_MEAN_RADIUS_METERS,
  STANDARD_TERRESTRIAL_K_FACTOR,
  effectiveEarthCurvatureDropMeters,
  terrestrialRefractionCorrectionDegrees,
} from "../geodesy/terrestrialRefraction";
import { weatherForDate } from "../search/refractionWeatherModel";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";

export const ABSOLUTE_MIN_DISTANCE_METERS = 8;
export const ABSOLUTE_MAX_DISTANCE_METERS = 50_000;
// 初回は粗い距離走査で画角内候補を絞り、交差区間だけ詳細化する。
const DEFAULT_SAMPLE_COUNT = 32;
// 交点取りこぼし防止用の補助走査。初期32点は維持しつつ、広すぎる区間だけを
// 10m DEMで一括補間する。全域を1m化しないため、精度向上と通信量抑制を両立する。
//
// 2026-08-29修正（実機の現地確認・過去のCLAUDE_HANDOFF文書「実証ケース
// 約968m」・実データでの再現テストにより確定）: 従来は500mだった。実際の
// 生データ診断（1050m〜1511mの範囲で20〜30m間隔）と、テスト
// （tests/regression配下ではなく、この修正の検証時に一時的に作成した
// 再現テストで確認）の両方で、幅40〜80m規模の実在する地形の起伏
// （堤防・土手のような、川沿いでよくある規模の高低差）が、500m間隔の
// 補完では観測点の間に完全に埋もれてしまい、粗探索の交点候補として
// 一切検出されないことを確認した。これは978m付近の交点候補が見つかる
// 一方で、そのすぐ近く（十数〜数十m）にある、より正しい交点（現地確認
// 済み）が交点候補にすら挙がらない、という実機報告と一致する。
// 500mを30mへ縮めることで、地形の生データで確認されている規模の起伏を
// 確実に補足できるようにした。典型的な検索窓（既定の距離ヒント無し、
// 一次探索範囲8m〜1200m程度）では、これによりサンプル数は約32点から
// 約62点へ増える程度（ADAPTIVE_MAX_TOTAL_SAMPLES=640の上限に対して
// 十分小さい）。10m DEMのままで1m化はしないため、通信量・精度条件は
// 変更していない。
//
// 2026-08-29追記（重要な訂正）: 30m版でも実機の症状が解消しなかった
// ことを受けて、根拠なく10mへさらに縮めようとしたが、これは「実際の
// 地形の起伏幅を確認しないまま、数値を当てずっぽうに動かしただけ」で
// あり、理論的な裏付けのない対症療法だと指摘を受け、撤回した。30mという
// 値自体も、実データで確認できた「幅40〜80m規模の起伏」に対する
// 一つの安全マージンでしかなく、実際の起伏がこれより狭い場合に本当に
// 十分かどうかは、まだ検証できていない。この先の対応は、根拠のない
// 数値変更ではなく、23件目で追加した「初期交点の内訳」診断で実際に
// 何が起きているか（候補がそもそも見つからないのか、見つかった上で
// 別の理由で失敗しているのか）を確認してから判断する。
const ADAPTIVE_COARSE_MAX_SPAN_METERS = 30;
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
// 2026-09-01変更: round-trip投影によるフレーミング判定・棄却を撤廃した
// ため、この定数は不要になった。
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
  // 2026-09-02追記: 「R2ヒット0・R2ミス0なのに遅い」というパターンの
  // 原因切り分けのため、サーバーへ到達する前段（端末内の生DEMタイル
  // デコードキャッシュ）の活動もあわせて記録する。
  localTileMemoryHitCount: number;
  localTileIndexedDbHitCount: number;
  localTileDecodeMissCount: number;
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
        // 2026-08-29追記: 実機診断で「dx/dyがしきい値に近いのに惜しいの
        // か、探索が全く進んでいないのか」を区別できるようにするため、
        // refineWithManualEquivalentProjection()が実際に何パス実行し、
        // 1パス目と最終パスでスコア（dx/dyのhypot、%）がどう変化したかを
        // 記録する。パス数が少ない・スコアが改善していない場合は、
        // 探索窓の外に真の解がある/そもそも近傍に解が無い可能性が高いと
        // 判断できる。
        refinementPassesUsed: number | null;
        firstPassScorePercent: number | null;
        finalScorePercent: number | null;
        // 2026-08-29追記: 複数の交点候補を並行処理すると、パス推移の
        // グローバル変数（診断専用）は「最後に処理された候補」の値で
        // 上書きされてしまい、本当に見たい（棄却された）候補の推移が
        // 別の（確定した）候補のもので上書きされてしまう欠陥があった。
        // 棄却理由ごとに、その候補自身のパス推移をここへ直接記録する。
        refinementPassTrace: Array<{
          pass: number;
          centerDistanceMeters: number;
          radialRadiusMeters: number;
          bestScorePercent: number | null;
          bestDistanceMeters: number | null;
          onEdge: boolean;
        }> | null;
      }>;
      // 2026-08-29追記: 「交点候補3件→確定1件・除外理由なし」のように
      // 数が合わない実機報告があった。原因を推測せず特定できるよう、
      // 見つかった全ての初期交点候補（粗探索の段階のもの）について、
      // 最終的にどうなったか（確定/棄却/重複として除去）を1件ずつ
      // 記録する。reject()を経由しない失敗（重複除去等）も含めて
      // 全件の行方を追える。
      intersectionOutcomes: Array<{
        initialDistanceMeters: number;
        outcome: "aligned" | "rejected" | "deduplicated" | "processing-failed";
        finalDistanceMeters: number | null;
      }>;
      /** 2026-08-30: 1回の実機ログだけで停止/例外箇所を特定する完全経路トレース。 */
      traceEvents: Array<{
        elapsedMs: number;
        stage: string;
        detail: string;
      }>;
    }
  >;
};

let lastSearchDiagnostics: TripodSearchDiagnostics | null = null;

export type TripodPhysicsAudit = {
  celestialLabel: string;
  calculationMode: CalculationMode;
  dateIso: string;
  lensCenterHeightMeters: number;
  referenceObserver: {
    latitude: number;
    longitude: number;
    legacyHeightMeters: number;
    ellipsoidalHeightMeters: number;
    orthometricHeightMeters: number;
    geoidHeightMeters: number | null;
    inferredGroundEllipsoidalHeightMeters: number;
    inferredGroundOrthometricHeightMeters: number;
    ecefX: number;
    ecefY: number;
    ecefZ: number;
  };
  subject: {
    latitude: number;
    longitude: number;
    legacyHeightMeters: number;
    ellipsoidalHeightMeters: number;
    orthometricHeightMeters: number;
    geoidHeightMeters: number | null;
    heightSource: string | null;
    ecefX: number;
    ecefY: number;
    ecefZ: number;
  };
  line: {
    geodesicDistanceMeters: number;
    slantDistanceMeters: number;
    bearingDegrees: number;
    ellipsoidalHeightDifferenceMeters: number;
    orthometricHeightDifferenceMeters: number;
    sphericalCurvatureDropMeters: number;
    effectiveCurvatureDropK013Meters: number;
    terrestrialRefractionCorrectionDegrees: number;
  };
  subjectElevation: {
    geometricDegrees: number;
    apparentDegrees: number;
    refractionCorrectionDegrees: number;
  };
  celestialElevation: {
    geometricDegrees: number | null;
    apparentDegrees: number;
    astronomicalRefractionCorrectionDegrees: number | null;
    azimuthDegrees: number;
  };
  centerline: {
    azimuthErrorDegrees: number;
    altitudeErrorDegrees: number;
    equivalentVerticalErrorMeters: number;
  };
  weather: {
    requestedMode: string | null;
    effectiveMode: string | null;
    source: string | null;
    temperatureCelsius: number | null;
    surfacePressureHpa: number | null;
    relativeHumidityPercent: number | null;
  };
};

let lastPhysicsAudits: TripodPhysicsAudit[] = [];

export function getLastTripodPhysicsAudits(): TripodPhysicsAudit[] {
  return lastPhysicsAudits;
}

function finiteOrNull(value: number | undefined): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

function buildTripodPhysicsAudit(
  subject: GroundPoint,
  point: CelestialScreenPoint,
  referenceLensObserver: GroundPoint,
  lensCenterHeightMeters: number,
  date: Date,
  calculationMode: CalculationMode,
  refractionWeather?: RefractionWeatherContext
): TripodPhysicsAudit {
  // referenceLensObserver は App.tsx で既に withLensCenterHeight() 済み。
  // ここでカメラ高をもう一度加えない。二重加算の有無も、地表高を逆算して
  // 診断へ出すことで実機ログだけで判定できるようにする。
  const observerEllipsoidal = ellipsoidalHeightMeters(referenceLensObserver);
  const observerOrthometric = orthometricHeightMeters(referenceLensObserver);
  const subjectEllipsoidal = ellipsoidalHeightMeters(subject);
  const subjectOrthometric = orthometricHeightMeters(subject);
  const observerEcef = Cartesian3.fromDegrees(
    referenceLensObserver.longitude,
    referenceLensObserver.latitude,
    observerEllipsoidal
  );
  const subjectEcef = Cartesian3.fromDegrees(
    subject.longitude,
    subject.latitude,
    subjectEllipsoidal
  );
  const line = calculateKarneyLineMetrics(referenceLensObserver, subject);
  const geometric = calculateGeometricElevation(referenceLensObserver, subject);
  const subjectElevation = computeApparentElevation(referenceLensObserver, subject, calculationMode);
  const celestial = calculateCelestialHorizontalCoordinates(
    point.id,
    date,
    referenceLensObserver,
    calculationMode,
    refractionWeather
  );
  const azimuthErrorDegrees = signedAngularDifferenceDegrees(
    line.bearingDegrees,
    celestial.azimuthDegrees
  );
  const altitudeErrorDegrees =
    subjectElevation.apparentAltitudeDegrees - celestial.altitudeDegrees;
  const weather = refractionWeather ? weatherForDate(refractionWeather, date) : null;
  const sphericalCurvatureDropMeters =
    line.distanceMeters * line.distanceMeters / (2 * EARTH_MEAN_RADIUS_METERS);
  return {
    celestialLabel: point.label,
    calculationMode,
    dateIso: date.toISOString(),
    lensCenterHeightMeters,
    referenceObserver: {
      latitude: referenceLensObserver.latitude,
      longitude: referenceLensObserver.longitude,
      legacyHeightMeters: referenceLensObserver.height,
      ellipsoidalHeightMeters: observerEllipsoidal,
      orthometricHeightMeters: observerOrthometric,
      geoidHeightMeters: finiteOrNull(referenceLensObserver.geoidHeightMeters),
      inferredGroundEllipsoidalHeightMeters: observerEllipsoidal - lensCenterHeightMeters,
      inferredGroundOrthometricHeightMeters: observerOrthometric - lensCenterHeightMeters,
      ecefX: observerEcef.x,
      ecefY: observerEcef.y,
      ecefZ: observerEcef.z,
    },
    subject: {
      latitude: subject.latitude,
      longitude: subject.longitude,
      legacyHeightMeters: subject.height,
      ellipsoidalHeightMeters: subjectEllipsoidal,
      orthometricHeightMeters: subjectOrthometric,
      geoidHeightMeters: finiteOrNull(subject.geoidHeightMeters),
      heightSource: subject.heightSource ?? null,
      ecefX: subjectEcef.x,
      ecefY: subjectEcef.y,
      ecefZ: subjectEcef.z,
    },
    line: {
      geodesicDistanceMeters: line.distanceMeters,
      slantDistanceMeters: geometric.slantDistanceMeters,
      bearingDegrees: line.bearingDegrees,
      ellipsoidalHeightDifferenceMeters: subjectEllipsoidal - observerEllipsoidal,
      orthometricHeightDifferenceMeters: subjectOrthometric - observerOrthometric,
      sphericalCurvatureDropMeters,
      effectiveCurvatureDropK013Meters: effectiveEarthCurvatureDropMeters(
        line.distanceMeters,
        STANDARD_TERRESTRIAL_K_FACTOR
      ),
      terrestrialRefractionCorrectionDegrees: terrestrialRefractionCorrectionDegrees(
        geometric.slantDistanceMeters,
        STANDARD_TERRESTRIAL_K_FACTOR
      ),
    },
    subjectElevation: {
      geometricDegrees: subjectElevation.geometricAltitudeDegrees,
      apparentDegrees: subjectElevation.apparentAltitudeDegrees,
      refractionCorrectionDegrees:
        subjectElevation.apparentAltitudeDegrees - subjectElevation.geometricAltitudeDegrees,
    },
    celestialElevation: {
      geometricDegrees: finiteOrNull(celestial.geometricAltitudeDegrees),
      apparentDegrees: celestial.altitudeDegrees,
      astronomicalRefractionCorrectionDegrees: Number.isFinite(celestial.geometricAltitudeDegrees)
        ? celestial.altitudeDegrees - (celestial.geometricAltitudeDegrees as number)
        : null,
      azimuthDegrees: celestial.azimuthDegrees,
    },
    centerline: {
      azimuthErrorDegrees,
      altitudeErrorDegrees,
      equivalentVerticalErrorMeters:
        Math.tan(CesiumMath.toRadians(altitudeErrorDegrees)) * line.distanceMeters,
    },
    weather: {
      requestedMode: refractionWeather?.requestedMode ?? null,
      effectiveMode: refractionWeather?.effectiveMode ?? null,
      source: refractionWeather?.source ?? null,
      temperatureCelsius: weather?.temperatureCelsius ?? null,
      surfacePressureHpa: weather?.surfacePressureHpa ?? null,
      relativeHumidityPercent: weather?.relativeHumidityPercent ?? null,
    },
  };
}


/**
 * 2026-08-26追記: 旧ECEFレイ一次探索が「一次探索(狭い範囲)」
 * と「二次探索(ほぼ全距離範囲)」のどちらに落ちたかを、直近1回分だけ
 * 記録する診断用変数。天体ごとに複数回呼ばれるため、都度recordDiagnostics
 * 呼び出し時点の最新値を使う（同一天体内で複数交点があると上書きされるが、
 * 「395点のような多さの原因が二次探索の発生にあるか」の確認には十分）。
 */
let lastScanFallbackInfo: { usedFallback: boolean; primaryMaxMeters: number } | null = null;

/**
 * 2026-08-29追記: 「探索は完了して確定/棄却されたが、その結論自体が
 * 現地確認と食い違う」という報告（推測での修正では解決できなかった）を
 * 受け、原因を推測ではなく実データで特定できるようにする診断専用の
 * 記録。scanRayTerrainIntersections()の粗探索段階（密度補完後・精密化前）
 * で実際に計算された「距離ごとのレイ高と地形高の差（m）」を、直近1回分
 * だけ保持する。これにより、"確定/現地の位置"に対応する距離の近くで
 * 符号が変化している（＝交点の兆候がある）のに検出漏れしているのか、
 * それとも本当にその付近では符号変化が起きていない（＝この計算モデル
 * では別の場所が正解になっている）のかを、次回の診断コピーで直接
 * 判別できるようにする。探索の挙動・精度には一切影響しない。
 */
let lastCoarseScanSamples: Array<{ distanceMeters: number; heightErrorMeters: number }> | null = null;
let lastCenterlineScanSamples: Array<{
  distanceMeters: number;
  angularScoreDegrees: number;
  azimuthErrorDegrees: number;
  altitudeErrorDegrees: number;
}> | null = null;

export function getLastTripodSearchDiagnostics(): TripodSearchDiagnostics | null {
  return lastSearchDiagnostics;
}

/**
 * 診断専用: 直近の粗探索（scanRayTerrainIntersections、精密化前）で実際に
 * 計算された「距離ごとのレイ高と地形高の差[m]」の生データを返す。
 * 複数の天体・複数の交点候補がある場合は最後に処理されたものの値。
 * 探索結果そのものには一切使わない（診断コピー用の読み取り専用）。
 */
export function getLastCoarseScanSamples(): Array<{ distanceMeters: number; heightErrorMeters: number }> | null {
  return lastCoarseScanSamples;
}

export function getLastCenterlineScanSamples() {
  return lastCenterlineScanSamples;
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
  signal?: AbortSignal,
  sampledGeoidFallback?: number,
  trace?: (stage: string, detail: string) => void
): Promise<GroundPoint> {
  const base = buildCandidateGroundPoint(cartographic, subject, label);
  // 最終CameraModel探索のbestはGroundPointとして保持され、その後
  // Cartographic.fromDegrees()で最終候補を再構成する。この再構成で
  // worldTerrain側WeakMapの「このDEMサンプルに使ったジオイドN」が失われる。
  // その結果、地点別ジオイドAPIが一時失敗しただけでfallback不能となり、
  // manual-refinement-exceptionで正しい候補全体を棄却していた。
  // 元のDEM評価点が保持していたNを明示的に引き継ぎ、API取得は従来どおり
  // 優先するが、失敗時には同じDEMサンプルのNへ確実にfallbackできるようにする。
  const mappedGeoid = geoidHeightMetersForTerrainSample(cartographic);
  const sampledGeoid = Number.isFinite(mappedGeoid)
    ? mappedGeoid
    : (Number.isFinite(sampledGeoidFallback) ? sampledGeoidFallback : undefined);
  // 2026-08-29修正（実機診断より）: 国土地理院ジオイドCGIは応答が不安定
  // （タイムアウト実績あり、GEOID_FETCH_TIMEOUT_MS=15秒）で、この
  // "候補点1点だけの高精度取得"がここで失敗・タイムアウトすると、以前は
  // それだけで候補全体が「manual-refinement-exception」として棄却されて
  // いた（実機診断: 天体総時間15.1〜15.2秒、内訳と矛盾する長さ）。
  // 同じ検索の中で、この探索過程で既に取得できている地域代表値
  // （sampledGeoid、0.01度単位・ミリ未満の精度差しかない滑らかな量）が
  // 使える場合は、それを使ってでも候補を成立させることを優先し、点別の
  // より精密な値の取得は「取れれば使う、失敗しても候補自体は失わない」
  // ベストエフォートに格下げする。
  let exactGeoid: number | null = null;
  const hasSampleFallback = Number.isFinite(sampledGeoid);
  // 地形サンプル由来Nが既にある場合、地点別Nは精度向上のベストエフォート。
  // 15秒待って同じNへfallbackするのは時間軸操作を止めるだけなので、
  // fallback可能時だけ1.2秒で打ち切る。fallback不能時は従来の15秒を維持する。
  const pointGeoidTimeoutMs = hasSampleFallback ? 1_200 : 15_000;
  const geoidStartedAt = performance.now();
  trace?.("geoid:point:start", `timeout=${pointGeoidTimeoutMs}ms sampleN=${hasSampleFallback ? Number(sampledGeoid).toFixed(4) : "none"}`);
  try {
    exactGeoid = await fetchGsiGeoidHeightPointSpecific(cartographic, signal, pointGeoidTimeoutMs);
    trace?.("geoid:point:end", `elapsed=${(performance.now() - geoidStartedAt).toFixed(1)}ms exactN=${exactGeoid.toFixed(4)}`);
  } catch (error) {
    if (isAbortError(error) && signal?.aborted) throw error;
    if (!Number.isFinite(sampledGeoid)) {
      trace?.("geoid:point:error", `elapsed=${(performance.now() - geoidStartedAt).toFixed(1)}ms fallback=no error=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      throw error;
    }
    trace?.("geoid:point:fallback", `elapsed=${(performance.now() - geoidStartedAt).toFixed(1)}ms sampleN=${Number(sampledGeoid).toFixed(4)} error=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    console.warn(
      `[tripod-candidate] ${label}: 候補点別ジオイド高の取得に失敗したため、地域代表値で代替します`,
      error
    );
  }
  const geoidForOrthometric = Number.isFinite(sampledGeoid)
    ? (sampledGeoid as number)
    : (exactGeoid as number);
  const geoidForEllipsoidal = exactGeoid ?? geoidForOrthometric;
  const orthometric = cartographic.height - geoidForOrthometric;
  const ellipsoidal = orthometric + geoidForEllipsoidal;
  return {
    ...base,
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: orthometric,
    geoidHeightMeters: geoidForEllipsoidal,
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

function signedAngularDifferenceDegrees(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
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
  /** seedの由来。最終採否には使わず、幾何レイ再収束を適用するかの制御だけに使う。 */
  seedKind?: "geometric-ray" | "apparent-preview" | "centerline";
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
  preferredDistanceMeters?: number,
  // 2026-08-29修正（外部レビューにより判明）: この関数は「天体ごとに1回だけ
  // 行う一次の全域探索（8m〜primaryMax）」と「各初期交点候補ごとに、その
  // 候補付近だけを見直す局所再探索（processInitialSolutionInner内、
  // Promise.allSettledで複数候補を並列処理）」の両方から呼ばれる。
  // どちらの呼び出しも診断用グローバル変数lastCoarseScanSamplesへ同じ
  // ように書き込んでいたため、複数の初期交点がある場合、最後に完了した
  // 局所再探索（＝どれか1つの候補の狭い範囲だけ）のデータで上書きされ、
  // 「一次の全域探索で968m付近に交点の兆候があったかどうか」を診断コピー
  // から一切確認できない状態になっていた（実機診断の生データ範囲を
  // 逆算したところ、初期交点候補#1（1280.6m）自身の局所再探索の範囲と
  // 完全に一致していたことで判明）。一次の全域探索の呼び出しだけを
  // true、局所再探索側はfalseにして、診断が常に一次探索のデータを
  // 保持するようにする。探索の挙動・精度には一切影響しない。
  recordDiagnosticSamples = true
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
  // 診断専用: 精密化前の粗探索サンプル（距離・レイ高との差[m]）を記録する。
  // 2026-08-29修正: 一次の全域探索（recordDiagnosticSamples=true）の
  // データだけを記録し、各初期交点候補ごとの局所再探索（false）では
  // 上書きしないようにする。詳細は関数シグネチャのrecordDiagnosticSamples
  // 引数コメント参照。
  if (recordDiagnosticSamples) {
    lastCoarseScanSamples = distances.map((distance, index) => ({
      distanceMeters: distance,
      heightErrorMeters: errors[index],
    }));
  }
  if (brackets.length === 0) {
    // 2026-08-29修正（2026-08-07頃の旧実装との比較検証により判明）:
    // 現行方式は「符号が反転する交点（明確な交差）が1つも見つからなければ
    // 候補ゼロ」という設計だった。しかし2026-08-07頃の実装
    // （ECEFレイ・複数交点対応への書き直し以前のもの）は、交差が見つから
    // なくても「その時点で最も0に近かったサンプル」をそのまま後段の精密化
    // （手動ピン相当の詳細探索）へ渡し、そこから真の解へ近づける設計に
        // なっていた。実際に、その旧実装を今回問題になっている実地形パターン
    // （被写体からの距離1050〜1511mの実測データに968m付近の地形起伏を
    // 加えたもの）で再現テストしたところ、この「見つからなくても最も近い
    // 点から精密化する」設計のおかげで、密度の調整を一切行わなくても
    // 968m付近の正しい交点を発見・確定できることを確認した。
    // この安全策は、後のECEFレイ・複数交点対応への書き直しのどこかで
    // 失われていた。
    // 粗探索の密度不足（30m間隔化で対応済み）を補う、独立した二重の
    // 安全策として復元する。以降の精密化・round-trip判定条件（0.5%
    // 許容誤差）は一切変更していないため、ここで見つかった「最も近い点」
    // が実際には不正解であれば、従来どおり最終判定で正しく棄却される
    // （偽陽性を許すものではない）。
    const finiteIndexes = errors
      .map((error, index) => ({ error, index }))
      .filter(({ error }) => Number.isFinite(error));
    if (finiteIndexes.length === 0) return [];
    const closest = finiteIndexes.reduce((best, current) =>
      Math.abs(current.error) < Math.abs(best.error) ? current : best
    );
    return [{
      cartographic: sampled[closest.index],
      distanceMeters: distances[closest.index],
      altitudeErrorDegrees: closest.error,
    }];
  }

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
 * 2026-08-30: 旧「初回ECEFレイ×地形交点」の高速経路は、
 * 中心線ソルバへの全面切替に伴い削除。確定候補のseed生成には使用しない。
 */

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

async function calculateOneCandidates(
  subject: GroundPoint,
  point: CelestialScreenPoint,
  cameraSettings: CameraSettings,
  // 2026-09-01: round-trip投影によるフレーミング判定を撤廃したため、
  // 画角計算に使っていたこの引数は不要になった。呼び出し元の多い位置引数の
  // 並びを変えないよう、削除せず未使用のまま残す（TSの規約通り_始まりで
  // 明示）。
  _previewAspectRatio: number,
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
  // 2026-09-01: 同上の理由でround-trip投影（画面内位置補正）に使わなく
  // なった。
  _viewCorrection?: CameraViewCorrection,
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
  const traceEvents: TripodSearchDiagnostics["perCelestialBody"][string]["traceEvents"] = [];
  const trace = (stage: string, detail: string) => {
    traceEvents.push({ elapsedMs: performance.now() - bodyStartedAt, stage, detail });
  };
  trace("body:start", `date=${date.toISOString()} focal=${cameraSettings.focalLengthMm}mm cameraHeight=${lensCenterHeightMeters}m mode=${calculationMode}`);
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
      refinementPassesUsed: evaluation?.refinementPassesUsed ?? null,
      firstPassScorePercent: evaluation?.firstPassScorePercent ?? null,
      finalScorePercent: evaluation?.finalScorePercent ?? null,
      refinementPassTrace: evaluation?.refinementPassTrace ?? null,
    });
  };
  // 2026-08-29追記（外部レビューにより判明した確認済みの不整合への対応）:
  // 従来finalEvaluations（診断コピーの「最終判定詳細」）には、reject()を
  // 経由した棄却候補しか記録されなかった。確定（aligned）した候補自身の
  // 方位誤差・仰角誤差・dx/dy・スコアは、console.warn（ブラウザの開発者
  // コンソール、利用者には見えない）にしか出力されず、しかもその
  // console.warnは棄却分岐の中にしか無いため、確定候補では一切呼ばれず、
  // 実質的にどこにも残っていなかった。confirmed-alignedという専用の
  // reasonで、確定候補についても同じ形式で記録し、「約何%の誤差で
  // 合格したか」を次回以降の診断コピーから確認できるようにする。
  // rejectionReasonsのカウントには加算しない（実際には棄却されていない
  // ため）。
  const recordConfirmed = (evaluation: Partial<TripodSearchDiagnostics["perCelestialBody"][string]["finalEvaluations"][number]>) => {
    finalEvaluations.push({
      distanceMeters: evaluation.distanceMeters ?? null,
      reason: "confirmed-aligned",
      azimuthErrorDegrees: evaluation.azimuthErrorDegrees ?? null,
      altitudeErrorDegrees: evaluation.altitudeErrorDegrees ?? null,
      dxPercent: evaluation.dxPercent ?? null,
      dyPercent: evaluation.dyPercent ?? null,
      inFront: evaluation.inFront ?? null,
      refinementPassesUsed: evaluation.refinementPassesUsed ?? null,
      firstPassScorePercent: evaluation.firstPassScorePercent ?? null,
      finalScorePercent: evaluation.finalScorePercent ?? null,
      refinementPassTrace: evaluation.refinementPassTrace ?? null,
    });
  };
  const terrainSampler: TerrainSampler = async (samplePoints, sampleSignal, maximumDetail) => {
    const startedAt = performance.now();
    const callNo = terrainRoundTripCount + 1;
    trace("terrain:start", `#${callNo} points=${samplePoints.length} detail=${maximumDetail ?? "default"}`);
    try {
      const result = await outerTerrainSampler(samplePoints, sampleSignal, maximumDetail);
      const elapsed = performance.now() - startedAt;
      terrainRoundTripCount += 1;
      terrainRoundTripTotalMs += elapsed;
      terrainRequestedCount += result.length;
      const failed = result.filter((sample) => !sample || !Number.isFinite(sample.height)).length;
      terrainFailedCount += failed;
      trace("terrain:end", `#${callNo} returned=${result.length} failed=${failed} elapsed=${elapsed.toFixed(1)}ms`);
      return result;
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      trace("terrain:error", `#${callNo} ${e.name}: ${e.message} elapsed=${(performance.now() - startedAt).toFixed(1)}ms`);
      throw error;
    }
  };

  // 気象連動屈折（自動モード）は約0.05度（≈5.5km）格子でキャッシュされており、
  // 三脚候補の探索範囲（通常は被写体から数百m〜数km）はほぼ必ず同じ格子内に
  // 収まる。そのため、解が収束するたびに候補地点で再取得しても得られる値は
  // 事実上変わらない。ここで被写体地点を代表点として一度だけ解決し、以降の
  // 全交点・全反復で使い回すことで、同じキャッシュ値への冗長な非同期呼び出し
  // （IndexedDB読み出し）を削減する。天体方位・高度そのものは従来どおり
  // 各反復で候補地点ごとに再計算するため、精度への影響はない。
  let activeRefractionWeather = refractionWeather;
  // 仕様3-C: 主計算は「天体中心→被写体→後方」のECEF 3Dレイと地形表面の
  // 交点として求める。pointのaz/altを計算した観測地点のENUでECEF化してから
  // 被写体へ平行移動する。観測地点が不明な検索経路だけ被写体地点を使う。
  const rayDirectionObserver = initialDirectionObserver ?? withLensCenterHeight(
    subject,
    lensCenterHeightMeters,
    `${point.label}初期方向観測点`
  );
  // 2026-08-30復元: プレビューを正とする逆問題では、天体の真空幾何高度を
  // そのまま被写体通過レイへ使わない。プレビューで使われている天体の見かけ高度
  // point.altitudeDegrees から、同じ観測点での被写体視線に含まれる地表屈折分だけを
  // 戻し、ECEF幾何直線へ変換する。2026-08-23 bae177a で実証ケース約968mに
  // 合わせていた定義を、後続のカメラ高/高さ基準修正を維持したまま復元する。
  const initialSubjectElevation = computeApparentElevation(
    rayDirectionObserver,
    subject,
    calculationMode
  );
  const initialGroundRefractionDegrees =
    initialSubjectElevation.apparentAltitudeDegrees -
    initialSubjectElevation.geometricAltitudeDegrees;
  const initialRayAltitudeDegrees =
    point.altitudeDegrees - initialGroundRefractionDegrees;

  const initialRay = buildCelestialBackwardRay(
    subject,
    point.azimuthDegrees,
    initialRayAltitudeDegrees,
    rayDirectionObserver
  );
  if (!initialRay) return [];
  const directSeedDistance = directSightlineSeedDistanceMeters(
    subject,
    point.azimuthDegrees,
    initialRayAltitudeDegrees,
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

  // 暫定候補は気象・地形I/Oを一切待たずに通知する。精密探索では有効な
  // preview気象コンテキストが既にあればその同じ値を再利用し、無い場合だけ
  // resolverで解決する。最終候補で使う気象補正自体は省略しない。
  // The preview already resolves the same historical/forecast context for the
  // subject/tripod before candidate calculation. When that context is a valid
  // weather context, reuse it instead of hitting IndexedDB again on every
  // timeline stop. The resolver is retained as a fallback when preview weather
  // is absent or has fallen back to the standard atmosphere, so final accuracy
  // is not reduced.
  if (
    refractionWeatherResolver &&
    (!activeRefractionWeather || activeRefractionWeather.effectiveMode !== "weather")
  ) {
    const weatherStartedAt = performance.now();
    const resolvedWeather = await refractionWeatherResolver(subject, signal);
    weatherResolveMs += performance.now() - weatherStartedAt;
    abortIfRequested(signal);
    if (resolvedWeather) activeRefractionWeather = resolvedWeather;
  }

  // 2026-08-30 物理経路監査: 現在の三脚ピンが存在する場合、そのレンズ中心を
  // 「実証基準点」として、三脚候補探索を動かす前に全物理量を同時記録する。
  // 探索結果には一切使用しない診断専用。これにより、正しいプレビュー地点で
  // 被写体と天体が一致しているのに候補計算では約2.2°ずれる問題について、
  // 高さ基準・ECEF・曲率・地表屈折・天体大気差・気象のどの段で初めて差が
  // 発生するかを1回の実機ログから特定できる。
  if (initialDirectionObserver) {
    try {
      lastPhysicsAudits.push(buildTripodPhysicsAudit(
        subject,
        point,
        initialDirectionObserver,
        lensCenterHeightMeters,
        date,
        calculationMode,
        activeRefractionWeather
      ));
    } catch (error) {
      console.warn(`[tripod-candidate] ${point.label}: 物理経路監査ログの生成に失敗`, error);
    }
  }
  // 2026-08-27追記: 「実際に地面を確認して見つかった、前回の確かな
  // 答え」（searchProfile.preferredDistanceMeters）よりも、「地面を
  // 一切見ていない、机上の幾何学的な見積もり」（directSeedDistance）が
  // 優先される構造になっていた。directSeedDistanceは高度が正であれば
  // ほぼ常に何らかの値を返すため、結果として前回の確かな答えが実質的に
  // 一度も使われていなかった。被写体が変わっていない場合の距離ヒントは
  // App.tsx側で「同一被写体か」を確認した上でのみ渡されるため信頼でき、
  // 探索へ追加注入する1点としては優先すべきである。
  //
  // 2026-08-29修正（実機の現地確認より）: 上記の「仮にヒントが外れていても
  // 安全弁がある」という前提が誤りだった。preferredDistanceMeters
  // （前回の答え）は被写体が同じでも日時が変われば天体の方位・仰角が
  // 変わるため、真の交点とは無関係な別の地点に近い値になっていることが
  // ある。この値で一次探索の範囲（ひいてはサンプル密度）まで決めて
  // しまうと、範囲外に落ちて安全弁（全距離走査）が働くのではなく、
  // 範囲内の「ヒントに近いが誤った」別の交点を拾って一見正常に確定して
  // しまう（安全弁が働かない失敗モード）ことが実機で確認された。この
  // ため、探索範囲・サンプル密度を決める値（rangeSizingDistance）には
  // 必ずその場で新しく計算されるdirectSeedDistanceのみを使い、
  // preferredDistanceMetersは「注入する追加の1点」（injectedSample
  // DistanceMeters、既存の対数サンプル密度・範囲を一切変えない）としてだけ
  // 使うよう分離した。
  const effectiveSeedDistance = searchProfile?.preferredDistanceMeters ?? directSeedDistance ?? undefined;
  // 距離ヒントは診断表示には残すが、新しい中心線ソルバの探索範囲・順位付けには
  // 使用しない。過去の誤答を次回の正解条件へ混入させないため。
  const seedDistanceSource: "direct-geometric" | "preferred-hint" | "none" =
    searchProfile?.preferredDistanceMeters !== undefined
      ? "preferred-hint"
      : directSeedDistance !== null
        ? "direct-geometric"
        : "none";
  const initialScanStartedAt = performance.now();

  // 2026-08-30復元: 本計算の主seedを「天体中心→被写体中心→後方」の
  // ECEF 3DレイとDEM地形の全交点へ戻す。Karney地表測地線や距離総当たりの
  // centerline solverを最終候補座標の生成器にはしない。ここで得た交点はseedであり、
  // 後段の候補地点再計算・1m DEM・CameraModel round-tripを必ず通す。
  const initialSolutions = (await scanRayTerrainIntersections(
    initialRay,
    lensCenterHeightMeters,
    terrainSampler,
    signal,
    distanceRange,
    searchProfile,
    directSeedDistance ?? searchProfile?.preferredDistanceMeters,
    true
  )).map((solution) => ({ ...solution, seedKind: "geometric-ray" as const }));

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
      intersectionOutcomes: [],
      traceEvents,
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
  // 2026-08-29追記: 各初期交点候補（initialSolutions[index]）が最終的に
  // どうなったかを、reject()を経由しない失敗（Promise.allSettledの
  // rejected）も含めて1件ずつ記録する。
  const intersectionOutcomes: TripodSearchDiagnostics["perCelestialBody"][string]["intersectionOutcomes"] = [];
  for (let index = 0; index < convergedResults.length; index += 1) {
    const result = convergedResults[index];
    const initialDistanceMeters = initialSolutions[index]?.distanceMeters ?? Number.NaN;
    if (result.status === "fulfilled" && result.value) {
      converged.push(result.value);
      intersectionOutcomes.push({
        initialDistanceMeters,
        outcome: "aligned",
        finalDistanceMeters: result.value.distanceMeters,
      });
    } else if (result.status === "fulfilled" && !result.value) {
      // reject()を経由して正式に棄却された（finalEvaluationsに理由が
      // 別途記録されている）。
      intersectionOutcomes.push({
        initialDistanceMeters,
        outcome: "rejected",
        finalDistanceMeters: null,
      });
    } else if (result.status === "rejected") {
      if (isAbortError(result.reason)) throw result.reason;
      console.warn(`[tripod-candidate] ${point.label}: 交点候補の処理に失敗`, result.reason);
      intersectionOutcomes.push({
        initialDistanceMeters,
        outcome: "processing-failed",
        finalDistanceMeters: null,
      });
    }
  }

  async function processInitialSolution(
    initialSolution: TerrainSolution
  ): Promise<TripodCandidate | null> {
    // 2026-08-29追記（実機診断より）: 「交点候補3件→確定1件」なのに
    // 「除外理由: なし」（reject()による正式な棄却が0件）という、数が
    // 合わない状態が実機で確認された。これは、残り2件のいずれかで
    // reject()を経由しない生の例外（このtry/catchで囲まれていない
    // 箇所での例外）が発生し、Promise.allSettledの「rejected」経路へ
    // 落ちて、finalEvaluations（診断の「最終判定詳細」）に一切記録され
    // ないままconsole.warnだけで静かに失われていたことを示唆する
        // （利用者からは何も見えない）。粗探索の密度を上げた22件目の修正で、
    // 以前は見つからなかった交点が新たに見つかるようになった結果、
    // その候補の処理中に想定していなかった経路の例外が起きている
    // 可能性がある。原因を推測せず特定できるよう、この関数全体を
    // 診断用のtry/catchで囲み、既存のreject()を経由しない例外も
    // 「processing-exception」として必ず記録するようにする
    // （挙動・精度は変更せず、診断の可視性だけを上げる）。
    try {
      return await processInitialSolutionInner(initialSolution);
    } catch (error) {
      if (isAbortError(error)) throw error;
      reject("processing-exception", {
        distanceMeters: initialSolution.distanceMeters,
      });
      console.warn(
        `[tripod-candidate] ${point.label}: 交点候補の処理中に想定外の例外（reject()を経由しない経路）`,
        { distanceMeters: initialSolution.distanceMeters, error }
      );
      return null;
    }
  }

  async function processInitialSolutionInner(
    initialSolution: TerrainSolution
  ): Promise<TripodCandidate | null> {
    abortIfRequested(signal);
    let solution = initialSolution;
    // 2026-08-27追記: 地形通信自体は高速化できたが、依然として体感の
    // 遅さが残っていたため、通信以外（収束反復ループの計算・
    // refineWithManualEquivalentProjection・ジオイド取得）にかかる時間を
    // 分けて計測し、「謎の時間」の所在を特定できるようにする。
    const convergenceLoopStartedAt = performance.now();

    // 幾何ECEFレイ由来のseedだけは、従来どおり候補地点の最新天体方向へ
    // 最大3回再収束させる。一方、apparent-preview seedは実プレビューと同じ
    // 見かけ高度の逆解から得た点なので、ここで幾何レイへ強制的に戻すと
    // せっかく得た正解側seedを再び真空幾何交点へ引き戻してしまう。
    // apparent-preview seedはそのままCameraModel詳細探索へ渡す。
    if (initialSolution.seedKind === "geometric-ray") {
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

      // 候補地点で再計算したプレビューの見かけ天体方向を、その候補地点自身の
      // ENUでECEF方向へ変換する。ECEFは幾何直線なので、同じ候補地点から被写体へ
      // 向く地表視線の apparent-geometric 差だけを戻してレイ高度へ変換する。
      // これは2026-08-23 bae177aの再収束定義で、天体のgeometricAltitudeDegreesを
      // 直接使う後続変更（485d023）を撤回する。
      const groundRefractionDegrees =
        candidateSubjectElevation.apparentAltitudeDegrees -
        candidateSubjectElevation.geometricAltitudeDegrees;
      const refinedRayAltitudeDegrees =
        horizontal.altitudeDegrees - groundRefractionDegrees;
      const refinedRay = buildCelestialBackwardRay(
        subject,
        horizontal.azimuthDegrees,
        refinedRayAltitudeDegrees,
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
        solution.distanceMeters,
        // この呼び出しは特定の初期交点候補1件だけを対象にした局所再探索
        // であり、天体全体の一次探索ではない。診断用の生データダンプを
        // ここで上書きしない。
        false
      );
      if (localSolutions.length === 0) break;
      solution = localSolutions.reduce((nearest, candidate) =>
        Math.abs(candidate.distanceMeters - solution.distanceMeters) <
        Math.abs(nearest.distanceMeters - solution.distanceMeters)
          ? candidate
          : nearest
      );
      }
    }

    if (!Number.isFinite(solution.cartographic.height)) {
      reject("solution-height-invalid", { distanceMeters: solution.distanceMeters });
      return null;
    }
    const convergenceLoopMs = performance.now() - convergenceLoopStartedAt;
    convergenceLoopTotalMs += convergenceLoopMs;

    // 2026-09-01変更（明示指示により）: 従来ここから、候補地点周辺を
    // CameraModelで再探索し、プレビュー画面内のズレ（dx/dy%）が最小になる
    // 位置へ「補正」した上で、その補正結果が許容誤差に収まらなければ
    // 候補ごと棄却する処理（refineWithManualEquivalentProjection＋
    // round-trip判定）を行っていた。この処理を撤廃し、上の幾何レイ再収束
    // ループが求めた「天体中心→被写体→後方のレイと地形の交点」を、
    // カメラ高・その地点固有のジオイド補正だけ行って、そのまま最終候補
    // として返す。画角内に収まるかどうかによる選別・位置の補正は行わない
    // （被写体の真下であっても、その交点をそのまま候補として示す）。
    const refinementStartedAt = performance.now();
    trace("refinement:start", `seedDistance=${solution.distanceMeters.toFixed(2)}m`);
    const finalGroundPoint = await buildPointSpecificFinalCandidateGroundPoint(
      solution.cartographic,
      subject,
      `${point.label}三脚候補`,
      signal,
      geoidHeightMetersForTerrainSample(solution.cartographic),
      trace
    );
    // 2026-09-01追記: solution.distanceMetersはレイに沿ったパラメータ距離
    // であり、候補地点（緯度経度）から被写体までの測地線距離とは、天体の
    // 高度がある分だけわずかに異なる（回帰テストで、レイ距離700mの交点の
    // 測地線距離が708m程度になることを確認）。三脚候補として意味を持つ
    // 「距離」は、実際にその地点から被写体までの地表距離（測地線距離）の
    // 方であるべきなので、確定した候補地点自身の緯度経度から測地線距離を
    // 再計算して使う。
    const finalDistanceMeters = calculateKarneyLineMetrics(subject, finalGroundPoint).distanceMeters;
    const refinementMs = performance.now() - refinementStartedAt;
    refinementTotalMs += refinementMs;
    trace("refinement:end", `elapsed=${refinementMs.toFixed(1)}ms result=distance=${finalDistanceMeters.toFixed(2)}m（round-trip判定なし）`);

    recordConfirmed({
      distanceMeters: finalDistanceMeters,
      azimuthErrorDegrees: null,
      altitudeErrorDegrees: null,
      dxPercent: null,
      dyPercent: null,
      inFront: null,
      refinementPassesUsed: 0,
      firstPassScorePercent: null,
      finalScorePercent: null,
      refinementPassTrace: undefined,
    });

    return {
      id: point.id,
      label: point.label,
      latitude: finalGroundPoint.latitude,
      longitude: finalGroundPoint.longitude,
      height: ellipsoidalHeightMeters(finalGroundPoint),
      distanceMeters: finalDistanceMeters,
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

  // 2026-08-29追記: 上のfilterで重複として除去された候補（converged内には
  // あるがuniqueには残らなかったもの）を、「aligned」から「deduplicated」
  // へ訂正する。「3件見つかったのに1件しか確定しない」という実機報告が、
  // 実は複数の初期交点が同じ最終地点へ収束した結果の重複除去なのか、
  // それとも本当に失敗しているのかを区別できるようにする。
  const uniqueDistances = new Set(unique.map((candidate) => candidate.distanceMeters));
  for (const outcome of intersectionOutcomes) {
    if (
      outcome.outcome === "aligned" &&
      outcome.finalDistanceMeters !== null &&
      !uniqueDistances.has(outcome.finalDistanceMeters)
    ) {
      outcome.outcome = "deduplicated";
    }
  }

  // 旧方式はユーザーがONにした時だけ独立検算として1回実行する。
  // 本計算の候補を置換・除外しない（仕様3-H）。
  if (doubleCheckEnabled && unique.length > 0) {
    const doubleCheckStartedAt = performance.now();
    // 旧方式の独立ダブルチェック専用。新しい中心線本計算には使用しない。
    const legacyInitialBearing = (point.azimuthDegrees + 180) % 360;
    const verification = await solveTerrainDistance(
      subject,
      legacyInitialBearing,
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
    intersectionOutcomes,
    traceEvents,
  });
  // 2026-09-02変更（明示指示により）: 同一天体で複数の候補が見つかった
  // 場合、被写体から最も遠い1件だけを最終候補として返す（地図上に表示
  // される候補数を確実に1天体あたり最大1件へ絞り、描画・地図側の負荷を
  // 下げる狙い）。uniqueは既に距離の降順でソート済みのため、先頭が
  // 最遠の候補。診断（recordDiagnostics）には全件の情報をそのまま残し、
  // 「何件見つかって何件に絞ったか」を後から確認できるようにする。
  return unique.slice(0, 1);
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
  ) => void,
  /** 通常プレビューと同一のCameraModel指向補正。最終round-tripで被写体と天体の相対投影を比較する。 */
  viewCorrection?: CameraViewCorrection
): Promise<TripodCandidate[]> {
  const cameraSettings: CameraSettings = typeof cameraSettingsOrLensHeight === "number"
    ? {
        focalLengthMm: 24,
        lensCenterHeightMeters: cameraSettingsOrLensHeight,
      }
    : cameraSettingsOrLensHeight;
  abortIfRequested(signal);

  resetGsiElevationCacheStats();
  resetLocalTileCacheStats();
  lastCoarseScanSamples = null;
  lastCenterlineScanSamples = null;
  lastPhysicsAudits = [];
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
    localTileMemoryHitCount: 0,
    localTileIndexedDbHitCount: 0,
    localTileDecodeMissCount: 0,
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
        viewCorrection,
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
    const localTileStats = getLocalTileCacheStats();
    lastSearchDiagnostics.localTileMemoryHitCount = localTileStats.memoryHit;
    lastSearchDiagnostics.localTileIndexedDbHitCount = localTileStats.indexedDbHit;
    lastSearchDiagnostics.localTileDecodeMissCount = localTileStats.miss;
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
