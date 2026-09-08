import { Cartographic } from "cesium";
import {
  ABSOLUTE_MAX_DISTANCE_METERS,
  ABSOLUTE_MIN_DISTANCE_METERS,
  ADAPTIVE_COARSE_MAX_SPAN_METERS,
  buildCelestialBackwardRay,
  calculateTripodCandidates,
  densifyDistanceIntervals,
  logarithmicDistances,
  rayCartographicAtDistance,
} from "../cesium/tripodCandidates";
import { sampleWorldTerrain, sampleWorldTerrainNeutral } from "../cesium/worldTerrain";
import { beginGsiDeviceTileCapture, finishGsiDeviceTileCapture, recordGsiDeviceTileReferencesForPoints } from "../cesium/gsiDemTileCache";
import { idFor } from "../subjectStorage";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { isAbortError } from "../utils/runtimeErrors";
import { fetchSiteContexts, type SiteContextPoint } from "../search/siteContext";
import { writePersistentSiteContexts } from "./siteContextPersistentCache";
import {
  BEARING_STEP_DEGREES,
  clearBearingProfileCacheForSubject,
  getBearingProfile,
  setBearingProfile,
  type BearingProfileEntry,
} from "./tripodBearingProfileCache";

/**
 * 2026-09-05追記（全面設計変更）: 「方位ごとに実測地形プロファイルを保存し、
 * 高度（＝時刻）に関わらずどのパターンでも使い回す」方式。詳しい経緯は
 * tripodBearingProfileCache.tsの冒頭コメント参照。
 */

/** 全方位を覆う刻み幅。tripodBearingProfileCache.tsのBEARING_STEP_DEGREESと同じ値。 */
export const ALL_BEARINGS_STEP_DEGREES = BEARING_STEP_DEGREES;
const TOTAL_BEARINGS = Math.round(360 / ALL_BEARINGS_STEP_DEGREES);

const OPT_IN_STORAGE_KEY = "ksg-tripod-bearing-profile-subjects-v1";

const BEARING_TERRAIN_STAGE_TIMEOUT_MS = 45_000;

async function runBearingTerrainStage<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`方位地形取得が${Math.round(BEARING_TERRAIN_STAGE_TIMEOUT_MS / 1000)}秒でタイムアウトしました`));
    }, BEARING_TERRAIN_STAGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

export type BearingProfileOptIn = {
  subjectId: string;
  label: string;
  enabledAtIso: string;
};

function readOptIns(): BearingProfileOptIn[] {
  try {
    const raw = localStorage.getItem(OPT_IN_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOptIns(records: BearingProfileOptIn[]): BearingProfileOptIn[] {
  localStorage.setItem(OPT_IN_STORAGE_KEY, JSON.stringify(records));
  return records;
}

export function listBearingProfileOptIns(): BearingProfileOptIn[] {
  return readOptIns();
}

export function isBearingProfileEnabled(subjectId: string): boolean {
  return readOptIns().some((item) => item.subjectId === subjectId);
}

export function enableBearingProfile(subjectId: string, label: string): void {
  const current = readOptIns().filter((item) => item.subjectId !== subjectId);
  writeOptIns([{ subjectId, label, enabledAtIso: new Date().toISOString() }, ...current]);
}

export async function disableBearingProfile(subjectId: string): Promise<void> {
  writeOptIns(readOptIns().filter((item) => item.subjectId !== subjectId));
  await clearBearingProfileCacheForSubject(subjectId);
}

export type BearingBackfillProgress = {
  totalSteps: number;
  completedSteps: number;
  currentBearingDegrees: number | null;
  profilePoints?: number;
  highPrecisionPoints?: number;
  phase?: "terrain" | "water" | "osm" | "finalizing";
  terrainStage?: "profile" | "high-precision";
};

export type BearingBackfillResult = {
  profilePoints: number;
  highPrecisionPoints: number;
  demTileCount: number;
  demTileBytes: number;
  storageWriteFailures: number;
};

/**
 * 今日から… ではなく、0°から359°（刻み幅ALL_BEARINGS_STEP_DEGREES）まで
 * 全方位を対象に、まだ保存されていない方位の地形プロファイルだけを
 * 順番に取得する。1方位＝通常探索の粗探索1回ぶんの通信（8m〜50km、
 * 密度は通常探索と同じADAPTIVE_COARSE_MAX_SPAN_METERS基準）。
 */
export async function backfillBearingProfiles(params: {
  subjectId: string;
  subjectPoint: GroundPoint;
  cameraSettings: CameraSettings;
  signal?: AbortSignal;
  onProgress?: (progress: BearingBackfillProgress) => void;
  forceRefresh?: boolean;
}): Promise<BearingBackfillResult> {
  const { subjectId, subjectPoint, cameraSettings, signal, onProgress, forceRefresh = false } = params;
  beginGsiDeviceTileCapture(subjectId);
  const bearings = Array.from(
    { length: TOTAL_BEARINGS },
    (_, index) => index * ALL_BEARINGS_STEP_DEGREES
  );

  const pendingBearings: number[] = [];
  for (const bearing of bearings) {
    if (signal?.aborted) {
      const captured = await finishGsiDeviceTileCapture(subjectId);
      return { profilePoints: 0, highPrecisionPoints: 0, demTileCount: captured.tileCount, demTileBytes: captured.bytes, storageWriteFailures: captured.writeFailures };
    }
    const existing = await getBearingProfile(
      subjectId,
      cameraSettings.lensCenterHeightMeters,
      bearing
    );
    if (forceRefresh || !existing) pendingBearings.push(bearing);
  }

  const totalSteps = pendingBearings.length;
  let completedSteps = 0;
  let profilePoints = 0;
  let highPrecisionPoints = 0;
  const waterPrefetchPoints: SiteContextPoint[] = [];
  onProgress?.({ totalSteps, completedSteps, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "terrain" });
  if (totalSteps === 0) {
    const captured = await finishGsiDeviceTileCapture(subjectId);
    return { profilePoints, highPrecisionPoints, demTileCount: captured.tileCount, demTileBytes: captured.bytes, storageWriteFailures: captured.writeFailures };
  }

  // 通常探索の粗探索と同じ距離配列・同じ密度規則を使う（0.5m単位まで
  // 密にはしない＝あくまで交点の存在をブラケット検出するための密度で、
  // 最終cm精度は読み出し時に必ずライブの狭域再確認で取り直す）。
  const baseDistances = densifyDistanceIntervals(
    logarithmicDistances(
      { minMeters: ABSOLUTE_MIN_DISTANCE_METERS, maxMeters: ABSOLUTE_MAX_DISTANCE_METERS },
      32
    ),
    ADAPTIVE_COARSE_MAX_SPAN_METERS
  );

  for (const bearing of pendingBearings) {
    if (signal?.aborted) break;
    onProgress?.({ totalSteps, completedSteps, currentBearingDegrees: bearing, profilePoints, highPrecisionPoints, phase: "terrain", terrainStage: "profile" });

    const cartographicPoints = baseDistances.map((distanceMeters) => {
      const destination = calculateKarneyDestinationPoint(subjectPoint, bearing, distanceMeters);
      return { distanceMeters, destination };
    });

    let sampled;
    try {
      sampled = await runBearingTerrainStage(
        (stageSignal) => sampleWorldTerrain(
          cartographicPoints.map(({ destination }) =>
            Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
          ),
          stageSignal,
          "10m"
        ),
        signal
      );
    } catch (error) {
      if (signal?.aborted) break;
      console.warn(`[bearing-profile] 方位${bearing}°の地形取得に失敗しました`, error);
      completedSteps += 1;
      onProgress?.({ totalSteps, completedSteps, currentBearingDegrees: bearing });
      continue;
    }

    const entry: BearingProfileEntry = {
      bearingDegrees: bearing,
      points: cartographicPoints.map(({ distanceMeters, destination }, index) => ({
        distanceMeters,
        longitude: destination.longitude,
        latitude: destination.latitude,
        ellipsoidalHeightMeters: sampled[index]?.height ?? Number.NaN,
      })).filter((point) => Number.isFinite(point.ellipsoidalHeightMeters)),
      computedAtIso: new Date().toISOString(),
    };
    await setBearingProfile(subjectId, cameraSettings.lensCenterHeightMeters, bearing, entry);
    profilePoints += entry.points.length;

    // 2026-09-08: 周辺データ保存では粗い10mプロファイルだけでなく、同じ
    // 探索線上を利用可能な最詳細GSI DEM（1m要求、未整備域は既存の5m/10m
    // 優先順位へフォールバック）でも取得する。neutral補間を使うため、実際の
    // 三脚候補精密計算と同じ端末DEMタイルキャッシュを温める。
    onProgress?.({ totalSteps, completedSteps, currentBearingDegrees: bearing, profilePoints, highPrecisionPoints, phase: "terrain", terrainStage: "high-precision" });
    try {
      recordGsiDeviceTileReferencesForPoints(
        subjectId,
        cartographicPoints.map(({ destination }) => ({ latitude: destination.latitude, longitude: destination.longitude }))
      );
      await runBearingTerrainStage(
        (stageSignal) => sampleWorldTerrainNeutral(
          cartographicPoints.map(({ destination }) =>
            Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
          ),
          stageSignal,
          "1m"
        ),
        signal
      );
      highPrecisionPoints += cartographicPoints.length;
      // 水面判定は全23万点をOverpassへ投げず、各方位を均等に8点だけ抽出。
      // 実際の精密計算で照合した追加地点もsiteContext.tsが自動永続保存する。
      const stride = Math.max(1, Math.floor(cartographicPoints.length / 8));
      for (let i = 0; i < cartographicPoints.length && waterPrefetchPoints.length < TOTAL_BEARINGS * 8; i += stride) {
        const d = cartographicPoints[i].destination;
        waterPrefetchPoints.push({ latitude: d.latitude, longitude: d.longitude });
      }
    } catch (error) {
      if (signal?.aborted) break;
      console.warn(`[bearing-profile] 方位${bearing}°の高精度DEM事前取得に失敗しました`, error);
    }

    completedSteps += 1;
    onProgress?.({ totalSteps, completedSteps, currentBearingDegrees: bearing, profilePoints, highPrecisionPoints, phase: "terrain" });
  }
  // 2026-09-08: 河川・海判定を端末へ事前保存。最大80地点/要求で分割し、
  // ダウンロードスポットとの参照関係も記録する。失敗してもDEM保存済みデータは有効。
  const waterBatches = Math.ceil(waterPrefetchPoints.length / 80);
  let waterCompleted = 0;
  onProgress?.({ totalSteps: Math.max(1, waterBatches), completedSteps: 0, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "water" });
  for (let offset = 0; offset < waterPrefetchPoints.length && !signal?.aborted; offset += 80) {
    const batch = waterPrefetchPoints.slice(offset, offset + 80);
    try {
      const contexts = await fetchSiteContexts(batch, signal, false, "water-only");
      await writePersistentSiteContexts(batch, contexts, "water-only", false, subjectId);
    } catch (error) {
      if (signal?.aborted) break;
      console.warn("[bearing-profile] 水面・河川情報の事前保存に失敗しました", error);
    }
    waterCompleted += 1;
    onProgress?.({ totalSteps: Math.max(1, waterBatches), completedSteps: waterCompleted, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "water" });
  }
  // 被写体直近は道路・立入・建物等を含むfull Site Contextも保存する。
  const detailPoints: SiteContextPoint[] = [{
    latitude: subjectPoint.latitude,
    longitude: subjectPoint.longitude,
  }];
  for (const radius of [25, 100]) {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const d = calculateKarneyDestinationPoint(subjectPoint, bearing, radius);
      detailPoints.push({ latitude: d.latitude, longitude: d.longitude });
    }
  }
  onProgress?.({ totalSteps: 1, completedSteps: 0, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "osm" });
  try {
    const contexts = await fetchSiteContexts(detailPoints, signal, true, "full");
    await writePersistentSiteContexts(detailPoints, contexts, "full", true, subjectId);
  } catch (error) {
    if (!signal?.aborted) console.warn("[bearing-profile] OSM周辺情報の事前保存に失敗しました", error);
  }
  onProgress?.({ totalSteps: 1, completedSteps: 1, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "osm" });
  onProgress?.({ totalSteps: 1, completedSteps: 0, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "finalizing" });
  const captured = await finishGsiDeviceTileCapture(subjectId);
  onProgress?.({ totalSteps: 1, completedSteps: 1, currentBearingDegrees: null, profilePoints, highPrecisionPoints, phase: "finalizing" });
  return { profilePoints, highPrecisionPoints, demTileCount: captured.tileCount, demTileBytes: captured.bytes, storageWriteFailures: captured.writeFailures };
}

/**
 * キャッシュ済み地形プロファイル上で、指定した方位角・高度のレイが
 * 地形と交差する（符号が反転する）距離のおおよその値を全て見つける。
 * 通常探索の「粗探索→符号反転検出」と同じ考え方だが、通信は行わず
 * キャッシュ済みの実測データだけを使う。あくまで「どのあたりを
 * ライブで確認しにいくか」の当たりを付けるためのもので、この時点の
 * 値をそのまま最終結果として使うことはない（下のtryUseBearingProfileCache
 * 参照）。
 */
function findApproximateBracketsFromProfile(
  profile: BearingProfileEntry,
  subjectPoint: GroundPoint,
  azimuthDegrees: number,
  altitudeDegrees: number,
  lensCenterHeightMeters: number
): number[] {
  const ray = buildCelestialBackwardRay(subjectPoint, azimuthDegrees, altitudeDegrees);
  if (!ray) return [];
  const errors = profile.points.map((point) => {
    const rayPoint = rayCartographicAtDistance(ray, point.distanceMeters);
    if (!rayPoint || !Number.isFinite(rayPoint.height)) return Number.NaN;
    return (rayPoint.height - lensCenterHeightMeters) - point.ellipsoidalHeightMeters;
  });
  const brackets: number[] = [];
  for (let index = 1; index < errors.length; index += 1) {
    const previous = errors[index - 1];
    const current = errors[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const crossed = (previous <= 0 && current > 0) || (previous >= 0 && current < 0);
    if (!crossed) continue;
    const distancePrevious = profile.points[index - 1].distanceMeters;
    const distanceCurrent = profile.points[index].distanceMeters;
    const totalMagnitude = Math.abs(previous) + Math.abs(current);
    const t = totalMagnitude > 0 ? Math.abs(previous) / totalMagnitude : 0.5;
    brackets.push(distancePrevious + (distanceCurrent - distancePrevious) * t);
  }
  return brackets;
}

/**
 * 2026-09-05追記: ライブ検索（App.tsx）から呼ぶ、方位プロファイル
 * キャッシュの読み出し。
 *
 * 手順（天体1つごと）:
 * 1. その天体の現在の方位角から、三脚候補が存在しうる方位（反対側、
 *    ±180°）を求め、キャッシュ済みプロファイルを引く。無ければ
 *    このチェック全体を諦めてnullを返す（＝呼び出し側は今までどおり
 *    フル計算にフォールバックする）。
 * 2. キャッシュ済みの実測地形と、現在の高度から作ったレイを比較し、
 *    交点のおおよその距離（複数ありうる）を求める（通信なし）。
 * 3. 見つかったおおよその距離それぞれについて、ごく狭い範囲
 *    （距離レンジを大きく絞った状態）でcalculateTripodCandidatesを
 *    通常どおり呼び、cm精度の確定値を必ずライブで取り直す。
 *    これにより最終結果の精度・信頼性は通常探索と完全に同一のまま、
 *    時間のかかる全域粗探索だけを省略できる。
 * 4. 交点が1つも見つからなければ、空配列（＝候補なしを確認済み）を
 *    返す。これは「キャッシュが無くて分からない」とは異なり、正当な
 *    「探した結果、無かった」という結果なので、フォールバックはしない。
 */
export async function tryUseBearingProfileCache(
  subjectPoint: GroundPoint,
  enabledPoints: CelestialScreenPoint[],
  cameraSettings: CameraSettings,
  selectedDate: Date,
  calculationMode: CalculationMode,
  refractionWeather: RefractionWeatherContext | undefined,
  initialDirectionObserver: GroundPoint | undefined,
  signal?: AbortSignal
): Promise<TripodCandidate[] | null> {
  if (enabledPoints.length === 0) return null;
  if (Number.isNaN(selectedDate.getTime())) return null;

  const subjectId = idFor(subjectPoint);
  if (!isBearingProfileEnabled(subjectId)) return null;

  const collected: TripodCandidate[] = [];
  for (const point of enabledPoints) {
    if (signal?.aborted) throw new DOMException("計算を中止しました", "AbortError");
    if (!Number.isFinite(point.azimuthDegrees) || !Number.isFinite(point.altitudeDegrees)) {
      return null;
    }
    const tripodBearing = (point.azimuthDegrees + 180) % 360;
    const profile = await getBearingProfile(
      subjectId,
      cameraSettings.lensCenterHeightMeters,
      tripodBearing
    );
    if (!profile) return null;

    const approximateBrackets = findApproximateBracketsFromProfile(
      profile,
      subjectPoint,
      point.azimuthDegrees,
      point.altitudeDegrees,
      cameraSettings.lensCenterHeightMeters
    );

    for (const approximateDistance of approximateBrackets) {
      if (signal?.aborted) throw new DOMException("計算を中止しました", "AbortError");
      // 概算はあくまで「だいたいこの辺り」。屈折補正の微調整に加え、
      // 方位が1°刻みでキャッシュされている（実際のレイの方位とは最大
      // 0.5°ずれうる）ことによる横方向のズレ（遠距離ほど大きくなる）も
      // 吸収できるよう、余裕を持たせた広めの範囲でライブ再確認する。
      const margin = Math.max(500, approximateDistance * 0.1);
      try {
        // 2026-09-05修正: 通常のライブ探索と同じ気象・初期観測点を渡す。
        // これらを省略すると、キャッシュ経由の結果だけ標準大気差扱いに
        // なる等、通常探索と食い違う結果を返しかねない。
        const verified = await calculateTripodCandidates(
          subjectPoint,
          [point],
          cameraSettings,
          selectedDate,
          calculationMode,
          undefined,
          signal,
          undefined,
          {
            minMeters: Math.max(ABSOLUTE_MIN_DISTANCE_METERS, approximateDistance - margin),
            maxMeters: Math.min(ABSOLUTE_MAX_DISTANCE_METERS, approximateDistance + margin),
          },
          undefined,
          refractionWeather,
          undefined,
          undefined,
          false,
          initialDirectionObserver
        );
        collected.push(...verified);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn(
          `[bearing-profile] ${point.label} 距離約${Math.round(approximateDistance)}mの狭域再確認に失敗しました`,
          error
        );
        // この候補だけ諦める。他の候補・他の天体には影響させない。
      }
    }
  }
  return collected;
}
