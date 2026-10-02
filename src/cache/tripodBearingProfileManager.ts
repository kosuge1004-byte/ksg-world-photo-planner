import { Cartographic } from "cesium";
import {
  ABSOLUTE_MAX_DISTANCE_METERS,
  ABSOLUTE_MIN_DISTANCE_METERS,
  ADAPTIVE_COARSE_MAX_SPAN_METERS,
  buildCelestialBackwardRay,
  calculateTripodCandidates,
  densifyDistanceIntervals,
  logarithmicDistances,
  maximumTerrainProfileSamples,
  rayCartographicAtDistance,
} from "../cesium/tripodCandidates";
import { sampleWorldTerrainNeutral, terrainDataSource } from "../cesium/worldTerrain";
import { beginGsiDeviceTileCapture, finishGsiDeviceTileCapture, flushGsiDeviceTilePrefetchQueue, pauseGsiDeviceTilePrefetch, prefetchGsiDeviceTilesForSamples, recordGsiDeviceTileReferencesForPoints, resumeGsiDeviceTilePrefetch } from "../cesium/gsiDemTileCache";
import { idFor } from "../subjectStorage";
import { listDownloadedSpotData } from "./downloadedSpotData";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import { withLensCenterHeight, type GroundPoint } from "../types/points";
import type { BearingProfileBatchProfile } from "../types/bearingProfileBatch";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import { computeApparentElevation } from "../apparent/apparentElevation";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { isAbortError } from "../utils/runtimeErrors";
import {
  fetchBearingProfileBatchDetailed,
  fetchStaticPrecomputedBearingProfile,
} from "./bearingProfileBatchClient";
import { findPrecomputedBearingProfileTarget } from "../data/precomputedBearingProfileTargets";
import {
  BEARING_STEP_DEGREES,
  clearBearingProfileCacheForSubject,
  getBearingProfile,
  getBearingProfileWriteFailureCount,
  getBearingProfilesMany,
  setBearingProfile,
  type BearingProfileEntry,
} from "./tripodBearingProfileCache";

/**
 * 2026-09-05追記（全面設計変更）: 「方位ごとに実測地形プロファイルを保存し、
 * 高度（＝時刻）に関わらずどのパターンでも使い回す」方式。詳しい経緯は
 * tripodBearingProfileCache.tsの冒頭コメント参照。
 *
 * 2026-09-08〜09追記（サーバー側ジョブ化を試み、直接方式へ差し戻した経緯）:
 * 一時、この処理をCloudflare Worker（Queue Consumer）側で実行する設計に
 * 変更した（「タブ/アプリを完全に終了しても続く」ことを狙ったもの）。
 * しかし実機検証の結果、サーバー側ジョブ1回の中で全方位を処理すると
 * Cloudflare Workers無料プランのsubrequest上限に抵触するため、方位ループ
 * 自体は端末へ戻した。ただしDEM取得は /api/gsi-elevation（Pages Function）
 * を経由するため、Cloudflare側の外向き接続/subrequest制限は引き続き考慮
 * する必要がある。端末側とWorker側の並列数を別々に過大化しない。
 * サーバー側ジョブの実装一式
 * （server/bearingProfileDownloadJobs.ts等）は将来「完全終了しても
 * 続けたい」場合に備えて残してあるが、現在は未使用。
 */

/** 全方位を覆う刻み幅。tripodBearingProfileCache.tsのBEARING_STEP_DEGREESと同じ値。 */
export const ALL_BEARINGS_STEP_DEGREES = BEARING_STEP_DEGREES;
const TOTAL_BEARINGS = Math.round(360 / ALL_BEARINGS_STEP_DEGREES);

// 太陽・月・天の川中心のうち、北側へ最も大きく到達するのは月。
// 月の軌道傾斜（約5.15°）と黄道傾斜（約23.44°）を保守的に足した
// +28.75°を上限として使う。北半球で観測緯度がこれより高い場合、
// これら3天体は北天を通過できず、三脚側には理論上使わない南側方位帯が生じる。
// 南半球では天の川中心（J2000 -29.00781°）が月より僅かに南へ届くため、
// -29.01°を保守的下限とする。低緯度では削除せず360°を維持する。
const MAX_NORTH_CELESTIAL_DECLINATION_DEGREES = 28.75;
const MIN_SOUTH_CELESTIAL_DECLINATION_DEGREES = -29.01;
const CELESTIAL_BEARING_SAFETY_MARGIN_DEGREES = 3;

function normalizedBearingDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * 太陽・月・天の川中心が地平線より上に存在し得る理論方位から、
 * その反対側（+180°）にある三脚方位だけを返す。
 * 低緯度では月が天頂の北/南を跨ぎ得るため、安全側で全360°を返す。
 */
export function requiredCelestialTripodBearings(latitudeDegrees: number): number[] {
  const allBearings = Array.from(
    { length: TOTAL_BEARINGS },
    (_, index) => index * ALL_BEARINGS_STEP_DEGREES
  );
  if (!Number.isFinite(latitudeDegrees)) return allBearings;

  const latitudeRadians = latitudeDegrees * Math.PI / 180;
  const absoluteLatitude = Math.abs(latitudeDegrees);
  const limitingDeclinationDegrees = latitudeDegrees >= 0
    ? MAX_NORTH_CELESTIAL_DECLINATION_DEGREES
    : Math.abs(MIN_SOUTH_CELESTIAL_DECLINATION_DEGREES);

  // 天体の最大赤緯域に観測地点が入る場合、長期的には北天/南天の双方を
  // 通過し得るため方位を安全に削れない。
  if (absoluteLatitude <= limitingDeclinationDegrees) {
    return allBearings;
  }

  const declinationRadians = (latitudeDegrees >= 0
    ? MAX_NORTH_CELESTIAL_DECLINATION_DEGREES
    : MIN_SOUTH_CELESTIAL_DECLINATION_DEGREES) * Math.PI / 180;
  const ratio = Math.sin(declinationRadians) / Math.cos(latitudeRadians);
  if (!Number.isFinite(ratio) || Math.abs(ratio) >= 1) return allBearings;

  // 地平線上(h=0)での限界天体方位。USNO/Bowditchの標準式
  // cos(Az) = sin(dec) / cos(lat) を使用。三脚はその反対側。
  const riseAzimuthDegrees = Math.acos(Math.max(-1, Math.min(1, ratio))) * 180 / Math.PI;
  const tripodBoundaryA = normalizedBearingDegrees(riseAzimuthDegrees + 180);
  const tripodBoundaryB = normalizedBearingDegrees((360 - riseAzimuthDegrees) + 180);

  const angularDistance = (a: number, b: number): number => {
    const delta = Math.abs(normalizedBearingDegrees(a) - normalizedBearingDegrees(b));
    return Math.min(delta, 360 - delta);
  };

  // 北半球では必要帯は北(0°)を跨ぐ側、南半球では南(180°)を跨ぐ側。
  const centerBearing = latitudeDegrees >= 0 ? 0 : 180;
  const halfWidth = Math.max(
    angularDistance(centerBearing, tripodBoundaryA),
    angularDistance(centerBearing, tripodBoundaryB)
  ) + CELESTIAL_BEARING_SAFETY_MARGIN_DEGREES;

  return allBearings.filter((bearing) => angularDistance(centerBearing, bearing) <= halfWidth);
}

const OPT_IN_STORAGE_KEY = "ksg-tripod-bearing-profile-subjects-v1";

// 2026-09-10修正: 方位全体を20秒で打ち切る外側Watchdogを撤去。
// 内部のDEM HTTP要求には個別のタイムアウト/abort処理があるため、複数バッチや
// 回復分割が正常に継続している方位を合計時間だけで強制終了しない。
// 方位同士は独立しているが、各方位内でもDEM APIが並列取得を行うため
// 過剰並列にはしない。2方位だけ重ね、待ち時間を隠しつつGSI/Cloudflareを保護する。
const BEARING_CONCURRENCY = 2;
// A registered spot is one immutable R2 object containing all 360 bearings.
// Ask for all pending bearings at once so a normal 259-bearing download uses
// one client/Worker/R2 round trip. Unregistered coordinates receive an explicit
// 404 and retain the precise direct path below.
// Immutable registered-spot files are intentionally fetched in one request.
// An arbitrary exact coordinate is calculated at the E-drive origin in small
// bounded chunks: real E-drive/GSI measurements show that 32 fresh bearings
// can approach the 30 second origin deadline, while 24 leaves transport margin
// and commits each completed chunk before the next one starts.
const PRECOMPUTED_BEARING_BATCH_SIZE = 360;
const EDRIVE_EXACT_BEARING_BATCH_SIZE = 24;
// 2026-09-08の実測: 公開APIで1方位352点の直接取得に約25.4秒。
const DIRECT_PATH_SECONDS_PER_BEARING_ESTIMATE = 25;

function validBatchProfile(
  value: unknown,
  bearingDegrees: number,
  distances: readonly number[],
  subjectPoint: GroundPoint
): value is BearingProfileBatchProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<BearingProfileBatchProfile>;
  if (profile.bearingDegrees !== bearingDegrees || !Array.isArray(profile.points) ||
    profile.points.length !== distances.length || typeof profile.computedAtIso !== "string") return false;
  return profile.points.every((point, index) => {
    if (typeof point !== "object" || point === null ||
      !Number.isFinite(point.distanceMeters) || !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) || !Number.isFinite(point.ellipsoidalHeightMeters) ||
      !(["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B", null] as const)
        .includes(point.elevationSource) ||
      Math.abs(point.distanceMeters - distances[index]) > 0.001) return false;
    const expected = calculateKarneyDestinationPoint(subjectPoint, bearingDegrees, distances[index]);
    return Math.abs(point.latitude - expected.latitude) <= 1e-9 &&
      Math.abs(point.longitude - expected.longitude) <= 1e-9;
  });
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
  phase?: "preparing" | "terrain" | "finalizing";
  terrainStage?: "profile" | "high-precision";
  /**
   * 計算済みデータ（R2）を使えず1方位ずつの直接取得へ切り替えた理由と目安時間。
   * 以前は切り替えが画面に出ず、0/257のまま止まって見えていた。
   */
  directFallbackNotice?: string;
  geoidCompleted?: number;
  geoidTotal?: number;
  // 2026-09-10追記（実機報告：「N/Total」が本当にデータを取得できている
  // 数なのか分からない）: completedStepsは成功・失敗を問わず「試行した
  // 方位の数」を数えており、実際に高精度DEMを取得・保存できた方位数
  // ではなかった。全て失敗し続けていても見た目には進んでいるように
  // 見えてしまうため、成功数・失敗数を別々に公開する。
  successfulSteps?: number;
  failedSteps?: number;
  /** 直近の失敗理由（communication error等）。憶測ではなく実際の原因を画面に出すため。 */
  lastFailureReason?: string | null;
};

export type BearingBackfillResult = {
  profilePoints: number;
  highPrecisionPoints: number;
  demTileCount: number;
  demTileBytes: number;
  storageWriteFailures: number;
  requestedBearings: number;
  successfulBearings: number;
  failedBearings: number;
  aborted: boolean;
  demTileFailures: number;
};

/**
 * 全方位ぶんの実測地形プロファイルを端末（ブラウザ）が直接取得し、
 * IndexedDBへ保存する。2026-09-08にサーバー側ジョブ化を試みたが、
 * Cloudflare Workers無料プランのsubrequest上限（50回/呼び出し）に
 * 抵触したため、この直接方式へ差し戻した（ファイル冒頭コメント参照）。
 * 高精度DEM取得段階にタイムアウトを設け、通信がハングしても永遠に
 * 固まらないようにする（2026-09-08のダウンロード停止修正）。
 * 2026-09-09以降、成功時に使われない10m先行取得は行わない。
 */
export async function backfillBearingProfiles(params: {
  subjectId: string;
  subjectPoint: GroundPoint;
  cameraSettings: CameraSettings;
  signal?: AbortSignal;
  onProgress?: (progress: BearingBackfillProgress) => void;
  forceRefresh?: boolean;
  /** 精度設定の三脚探索最大距離。一般地点は上限50km、富士山だけ100km。 */
  maxDistanceMeters?: number;
  /** Dynamic Spotの完成データ取込み時だけ全360方位を明示する。 */
  bearingsOverride?: readonly number[];
  /** Eドライブで完全性確認済みのDynamic Spotは1応答で取得できる。 */
  preferPrecomputed?: boolean;
  /** 自動同期では低速な1方位経路へ落とさず、次回のEドライブ再接続を待つ。 */
  allowDirectFallback?: boolean;
}): Promise<BearingBackfillResult> {
  const { subjectId, subjectPoint, cameraSettings, signal, onProgress, forceRefresh = false } = params;
  // 2026-09-10追記: 方位プロファイル本体の書き込み失敗（IndexedDBエラー・
  // 操作タイムアウト）を検知するため、開始時点の累計失敗回数を基準として
  // 記録しておく。DEMタイル側のwriteFailures計測と同じ「差分」方式。
  const bearingProfileWriteFailuresAtStart = getBearingProfileWriteFailureCount();
  const requestedMaxDistanceMeters = Math.min(
    ABSOLUTE_MAX_DISTANCE_METERS,
    Math.max(ABSOLUTE_MIN_DISTANCE_METERS, params.maxDistanceMeters ?? 10_000)
  );
  beginGsiDeviceTileCapture(subjectId);
  // During the latency-sensitive 360-bearing terrain pass, decoded DEM-tile
  // persistence is queued instead of competing for the same-origin/network slots.
  // The queued tiles are drained once, after all foreground elevation requests.
  pauseGsiDeviceTilePrefetch();
  let deviceTilePrefetchPaused = true;
  const resumeDeviceTilePrefetch = (): void => {
    if (!deviceTilePrefetchPaused) return;
    deviceTilePrefetchPaused = false;
    resumeGsiDeviceTilePrefetch();
  };
  let captureFinished = false;
  const finishCapture = async () => {
    captureFinished = true;
    return finishGsiDeviceTileCapture(subjectId);
  };
  try {
  // 360°を無条件取得せず、この被写体緯度で太陽・月・天の川中心が
  // 物理的に必要とし得る三脚方位だけを対象にする。低緯度は安全側で360°維持。
  const bearings = params.bearingsOverride
    ? Array.from(new Set(params.bearingsOverride)).filter((bearing) =>
        Number.isInteger(bearing) && bearing >= 0 && bearing < 360
      ).sort((left, right) => left - right)
    : requiredCelestialTripodBearings(subjectPoint.latitude);

  if (signal?.aborted) {
    resumeDeviceTilePrefetch();
    const captured = await finishCapture();
    return { profilePoints: 0, highPrecisionPoints: 0, demTileCount: captured.tileCount, demTileBytes: captured.bytes, storageWriteFailures: captured.writeFailures + (getBearingProfileWriteFailureCount() - bearingProfileWriteFailuresAtStart), requestedBearings: 0, successfulBearings: 0, failedBearings: 0, aborted: true, demTileFailures: captured.downloadFailures };
  }

  // 2026-09-09: 開始前に全方位を1件ずつIndexedDBから直列取得すると、
  // Android WebViewで開始ボタン押下後の待ち時間が大きくなる。
  // deviceCache既存の一括read APIで1 transactionにまとめる。
  const existingProfiles = forceRefresh
    ? bearings.map(() => null)
    : await getBearingProfilesMany(subjectId, cameraSettings.lensCenterHeightMeters, bearings);

  const pendingBearings = bearings.filter((_, index) => {
    if (forceRefresh) return true;
    const existing = existingProfiles[index];
    if (!existing || existing.points.length === 0) return true;
    // 短い範囲で保存済みのプロファイルを、後で範囲を広げた際に完成済みと
    // 誤認しない。長い既存データは短い要求にもそのまま利用可能。
    const existingMaxDistanceMeters = existing.points[existing.points.length - 1]?.distanceMeters ?? 0;
    return existingMaxDistanceMeters + 0.01 < requestedMaxDistanceMeters;
  });

  const totalSteps = pendingBearings.length;
  onProgress?.({ totalSteps, completedSteps: 0, currentBearingDegrees: null, phase: "terrain" });
  let directFallbackNotice: string | null = null;
  function reportProgress(progress: BearingBackfillProgress): void {
    onProgress?.(directFallbackNotice && progress.phase === "terrain"
      ? { ...progress, directFallbackNotice }
      : progress);
  }

  const baseDistances = densifyDistanceIntervals(
    logarithmicDistances(
      { minMeters: ABSOLUTE_MIN_DISTANCE_METERS, maxMeters: requestedMaxDistanceMeters },
      32
    ),
    ADAPTIVE_COARSE_MAX_SPAN_METERS,
    maximumTerrainProfileSamples(requestedMaxDistanceMeters)
  );

  let totalProfilePoints = 0;
  let totalHighPrecisionPoints = 0;
  let successfulBearings = 0;
  let failedBearings = 0;
  let completedAttempts = 0;
  // 2026-09-10追記（実機報告：「成功0・失敗2」は分かったが、なぜ失敗して
  // いるのかが画面から分からない）: 憶測で議論せずに済むよう、直近の
  // 失敗理由をそのまま画面へ表示できるようにする。
  let lastFailureReason: string | null = null;
  let nextIndex = 0;
  let abortReason: string | null = null;
  // A resumed download must preserve the tile references of already saved
  // bearings. No pending terrain bearings does not imply a complete download.
  existingProfiles.forEach((profile, index) => {
    if (!profile || pendingBearings.includes(bearings[index])) return;
    recordGsiDeviceTileReferencesForPoints(subjectId, profile.points);
    totalProfilePoints += profile.points.length;
    totalHighPrecisionPoints += profile.points.length;
  });

  async function acceptProfile(entry: BearingProfileEntry): Promise<void> {
    await setBearingProfile(
      subjectId,
      cameraSettings.lensCenterHeightMeters,
      entry.bearingDegrees,
      entry
    );
    recordGsiDeviceTileReferencesForPoints(subjectId, entry.points);
    totalProfilePoints += entry.points.length;
    totalHighPrecisionPoints += entry.points.length;
    successfulBearings += 1;
    completedAttempts += 1;
  }

  // Prefer the published all-bearing profile. Older deployments, an endpoint
  // miss for an unregistered coordinate, or a partial response fall back to
  // the established direct path for only the bearings that remain unresolved.
  // Values are accepted only when every distance and Karney destination matches
  // the locally generated profile, so this changes transport count, not precision.
  const remainingBearingSet = new Set(pendingBearings);
  let batchFallbackReason: string | null = null;
  const matchingTarget = findPrecomputedBearingProfileTarget(
    subjectPoint.latitude,
    subjectPoint.longitude
  );
  const requiredPrecomputedTarget =
    matchingTarget?.maxDistanceMeters === requestedMaxDistanceMeters
      ? matchingTarget
      : null;
  const bearingBatchSize = requiredPrecomputedTarget || params.preferPrecomputed
    ? PRECOMPUTED_BEARING_BATCH_SIZE
    : Math.max(1, Math.min(
        EDRIVE_EXACT_BEARING_BATCH_SIZE,
        Math.floor(240_000 / requestedMaxDistanceMeters)
      ));
  for (let start = 0; start < pendingBearings.length; start += bearingBatchSize) {
    if (signal?.aborted) break;
    const batchBearings = pendingBearings.slice(start, start + bearingBatchSize);
    reportProgress({
      totalSteps,
      completedSteps: completedAttempts,
      successfulSteps: successfulBearings,
      failedSteps: failedBearings,
      currentBearingDegrees: batchBearings[0] ?? null,
      phase: "terrain",
      terrainStage: "profile",
    });
    const batchRequest = {
      subjectPoint,
      cameraSettings: { lensCenterHeightMeters: cameraSettings.lensCenterHeightMeters },
      bearings: batchBearings,
      maxDistanceMeters: requestedMaxDistanceMeters,
    };
    // 2026-09-30: 取得順
    //   登録スポット: 静的配信の計算済みファイル（Functionsを通らない）
    //                 → /api/bearing-profile-batch（R2 → Eドライブ）
    //   任意座標:     /api/bearing-profile-batch（R2書き戻し → Eドライブ）
    // どちらでも得られない方位は、下の1方位経路（端末内 → R2 → Eドライブ →
    // 国土地理院）で続行する。以前は登録スポットだけここで例外終了していたが、
    // 1方位経路がサーバー非依存で完了できるようになったため止めない。
    let outcome = requiredPrecomputedTarget
      ? await fetchStaticPrecomputedBearingProfile(batchRequest, signal)
      : null;
    if (!outcome?.ok) {
      const staticReason = outcome && !outcome.ok ? outcome.miss.reason : null;
      outcome = await fetchBearingProfileBatchDetailed(batchRequest, signal);
      if (!outcome.ok && staticReason) {
        outcome = { ok: false, miss: { ...outcome.miss, reason: `${staticReason}／${outcome.miss.reason}` } };
      }
    }
    if (!outcome.ok) {
      batchFallbackReason = requiredPrecomputedTarget
        ? `${requiredPrecomputedTarget.name}の計算済み地形データを取得できないため、1方位ずつ取得します。${outcome.miss.reason}`
        : outcome.miss.reason;
      break;
    }
    const batch = outcome.response;
    if (batch.requestedBearingCount !== batchBearings.length ||
      batch.pointCount !== batchBearings.length * baseDistances.length) {
      batchFallbackReason = `計算済み地形データの点数が一致しません（${batch.pointCount} / ${batchBearings.length * baseDistances.length}点）`;
      continue;
    }
    const usesCompleteServerTerrainProfile =
      batch.precomputed === true || batch.terrainProfileComplete === true;
    const profileByBearing = new Map(
      batch.profiles.map((profile) => [profile.bearingDegrees, profile] as const)
    );
    for (const bearing of batchBearings) {
      const profile = profileByBearing.get(bearing);
      if (!validBatchProfile(profile, bearing, baseDistances, subjectPoint)) continue;
      // The direct path warms the decoded device tiles after receiving the
      // authoritative elevation source for every point. Preserve that download
      // contract on the batch path; otherwise the profile would exist but the
      // explicit surrounding-DEM download would report/store zero tiles.
      // A registered-spot profile is itself the complete authoritative 1 m
      // calculation. Downloading every raw DEM tile again would duplicate the
      // expensive work and was the main reason an otherwise complete profile
      // still took minutes to save. Dynamic responses retain the established
      // tile warming path because no reusable server-side file exists for them.
      if (!usesCompleteServerTerrainProfile) {
        prefetchGsiDeviceTilesForSamples(
          profile.points.map((point) => ({
            latitude: point.latitude,
            longitude: point.longitude,
            maximumDetail: "1m" as const,
            interpolationMode: "neutral" as const,
          })),
          profile.points.map((point) => ({
            heightMeters: point.elevationSource === null ? null : 0,
            source: point.elevationSource,
          }))
        );
      }
      const entry: BearingProfileEntry = {
        bearingDegrees: profile.bearingDegrees,
        computedAtIso: profile.computedAtIso,
        points: profile.points.map((point) => ({
          distanceMeters: point.distanceMeters,
          longitude: point.longitude,
          latitude: point.latitude,
          ellipsoidalHeightMeters: point.ellipsoidalHeightMeters,
        })),
      };
      await acceptProfile(entry);
      remainingBearingSet.delete(bearing);
      reportProgress({
        totalSteps,
        completedSteps: completedAttempts,
        successfulSteps: successfulBearings,
        failedSteps: failedBearings,
        currentBearingDegrees: bearing,
        phase: "terrain",
        terrainStage: "high-precision",
        profilePoints: totalProfilePoints,
        highPrecisionPoints: totalHighPrecisionPoints,
      });
    }
  }
  const remainingBearings = pendingBearings.filter((bearing) => remainingBearingSet.has(bearing));
  if (remainingBearings.length > 0 && !signal?.aborted && params.allowDirectFallback === false) {
    resumeDeviceTilePrefetch();
    const captured = await finishCapture();
    return {
      profilePoints: totalProfilePoints,
      highPrecisionPoints: totalHighPrecisionPoints,
      demTileCount: captured.tileCount,
      demTileBytes: captured.bytes,
      storageWriteFailures: captured.writeFailures +
        (getBearingProfileWriteFailureCount() - bearingProfileWriteFailuresAtStart),
      requestedBearings: totalSteps,
      successfulBearings,
      failedBearings: remainingBearings.length,
      aborted: false,
      demTileFailures: captured.downloadFailures,
    };
  }
  // 2026-09-30: 以前はR2・Eドライブの一括経路で完全な結果を得られない場合、
  // ここで例外にしてダウンロードを失敗させていた（旧1方位経路が全点を
  // Pages Functions経由で取得し約54分かかっていたため）。現在の1方位経路は
  // 端末内 → R2 → Eドライブ → 国土地理院（サーバー経由）→ 国土地理院（端末から
  // 直接）の順で取得し、サーバーが応答しなくても端末の直接取得で完了できる。
  // World Terrainへの置換は従来どおり禁止（混入した方位は未完了扱い）のまま。
  if (remainingBearings.length > 0 && !signal?.aborted) {
    // 直接取得は1方位（約350点）ごとに国土地理院DEMとジオイドを取得するため、
    // 実測で1方位あたり約25秒（2並列）かかる。目安を示して「止まっている」
    // のではなく「遅い経路で動いている」ことを明示する。
    const estimatedMinutes = Math.max(1, Math.round(
      remainingBearings.length * DIRECT_PATH_SECONDS_PER_BEARING_ESTIMATE / BEARING_CONCURRENCY / 60
    ));
    directFallbackNotice =
      `計算済みデータを使えないため、1方位ずつ直接取得しています（理由: ${batchFallbackReason ?? "計算済みデータの一部が不足"}）。` +
      `1方位ごとに完了して数字が進みます。目安 約${estimatedMinutes}分以上。`;
    console.warn(`[bearing-profile] 直接取得へ切り替え: ${batchFallbackReason ?? "partial"}`);
  }

  // 2026-09-10追記: 「初期数方位が全失敗ならシステム障害として早期中止する」
  // 判定を実際に配線する。以前はabortReasonという変数だけが用意されていて、
  // どこからも代入されておらず、GSI/ジオイドAPIが落ちていても360方位を
  // 律儀に最後まで試行し続けていた（宣言だけのdead code）。1回の再取得でも
  // 解消しない失敗が一定数連続したら、通常のダウンロード再試行では回復
  // しない可能性が高いと判断し、早期に中止してその旨を明示する。
  const SYSTEMIC_FAILURE_CHECK_COUNT = Math.min(6, totalSteps);
  function maybeAbortForSystemicFailure(): void {
    if (abortReason) return;
    if (successfulBearings > 0) return;
    if (failedBearings < SYSTEMIC_FAILURE_CHECK_COUNT) return;
    abortReason = "国土地理院の詳細地形データまたはジオイド高を取得できないため中止しました。しばらく時間をおくか、通信状態を確認して再実行してください";
  }

  async function processBearing(index: number): Promise<void> {
    if (signal?.aborted || abortReason) return;
    const bearing = remainingBearings[index];
    reportProgress({
      totalSteps,
      completedSteps: completedAttempts,
      successfulSteps: successfulBearings,
      failedSteps: failedBearings,
      currentBearingDegrees: bearing,
      phase: "terrain",
      terrainStage: "profile",
    });

    const cartographicPoints = baseDistances.map((distanceMeters) => {
      const destination = calculateKarneyDestinationPoint(subjectPoint, bearing, distanceMeters);
      return { distanceMeters, destination };
    });
    const terrainPoints = cartographicPoints.map(({ destination }) =>
      Cartographic.fromDegrees(destination.longitude, destination.latitude, 0)
    );

    reportProgress({
      totalSteps,
      completedSteps: completedAttempts,
      successfulSteps: successfulBearings,
      failedSteps: failedBearings,
      currentBearingDegrees: bearing,
      phase: "terrain",
      terrainStage: "high-precision",
    });

    // Download only authoritative GSI heights. Each HTTP/cache operation has
    // its own cancellable deadline; healthy geoid queue waits are not failures.
    type HighPrecisionAttempt =
      | { ok: true; samples: Cartographic[] }
      | { ok: false; aborted: boolean; reason: string };

    async function fetchHighPrecisionOnce(): Promise<HighPrecisionAttempt> {
      try {
        // Each network/cache operation is bounded. A whole-bearing watchdog
        // incorrectly cancelled healthy rate-limited geoid work, then left its
        // Promise running behind the next attempt. The DEM client resolves its
        // sparse failedIndexes first by retrying only those exact points (at
        // most two individual retries); this whole-bearing attempt is reached
        // only after those point-level retries have been exhausted. A full API
        // outage skips per-point fan-out and is escalated directly.
        const samples = await sampleWorldTerrainNeutral(terrainPoints, signal, "1m", {
          allowWorldTerrainFallback: false,
          onGeoidProgress: (geoidCompleted, geoidTotal) => reportProgress({
            totalSteps, completedSteps: completedAttempts, successfulSteps: successfulBearings,
            failedSteps: failedBearings, currentBearingDegrees: bearing, phase: "terrain",
            terrainStage: "high-precision", geoidCompleted, geoidTotal,
          }),
        });
        return { ok: true, samples };
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return { ok: false, aborted: true, reason: "中断" };
        console.warn(`[bearing-profile] 方位${bearing}°の1m高精度地形取得に失敗しました`, error);
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, aborted: false, reason };
      }
    }

    // 2026-09-10追記（実機報告：138タワーパークで放置しても1方位あたり
    // 数分かかり続ける）: 「1回だけ取り直す」は数秒程度で終わる一過性の
    // 不調からの回復を意図していたが、ジオイド高APIがセッション全体を通じて
    // 恒常的に遅い場合（この方位のように水面をまたぐ点が多いと、ジオイド
    // API呼び出しが多くなり影響を受けやすい）、初回の試行が既に長時間
    // かかった上で、さらに同じだけの時間をもう一度待つだけになり、成功する
    // 見込みを高めないまま所要時間だけを倍にしてしまっていた。初回が
    // 十分speedy（一過性の不調が疑える）だった場合だけ取り直す。
    const RETRY_ELIGIBLE_MAX_ELAPSED_MS = 8_000;
    const firstAttemptStartedAt = Date.now();
    let attempt = await fetchHighPrecisionOnce();
    const firstAttemptElapsedMs = Date.now() - firstAttemptStartedAt;
    if (
      firstAttemptElapsedMs <= RETRY_ELIGIBLE_MAX_ELAPSED_MS &&
      ((!attempt.ok && !attempt.aborted) ||
        (attempt.ok && attempt.samples.some((sample) => terrainDataSource(sample) === "CESIUM_WORLD_TERRAIN")))
    ) {
      if (!signal?.aborted) {
        // 通信・ジオイド高の一時的な不調を切り分けるための、内容を変えない
        // 1回だけの再取得。座標・精度・DEMソース優先順位は変えない。
        const retried = await fetchHighPrecisionOnce();
        if (retried.ok) attempt = retried;
      }
    }

    if (!attempt.ok) {
      if (attempt.aborted) return;
      failedBearings += 1;
      completedAttempts += 1;
      lastFailureReason = attempt.reason;
      reportProgress({ totalSteps, completedSteps: completedAttempts, successfulSteps: successfulBearings, failedSteps: failedBearings, lastFailureReason, currentBearingDegrees: bearing, phase: "terrain", terrainStage: "high-precision", profilePoints: totalProfilePoints, highPrecisionPoints: totalHighPrecisionPoints });
      maybeAbortForSystemicFailure();
      return;
    }
    const precise = attempt.samples;
    if (precise.length !== terrainPoints.length || precise.some((point) => !Number.isFinite(point.height))) {
      failedBearings += 1;
      completedAttempts += 1;
      lastFailureReason = "高精度地形の応答点数または高さが不正です";
      reportProgress({ totalSteps, completedSteps: completedAttempts, successfulSteps: successfulBearings,
        failedSteps: failedBearings, lastFailureReason, currentBearingDegrees: bearing, phase: "terrain" });
      maybeAbortForSystemicFailure();
      return;
    }

    // sampleWorldTerrainNeutralは通常検索では通信障害時にCesium World Terrainへ
    // フォールバックできるが、「高精度周辺データのダウンロード」ではそれを
    // GSI高精度DEM取得成功として保存してはいけない。GSI/水面0m以外が混じれば
    // （1回の再取得後も解消しなければ）この方位は未完了として再実行対象に残す。
    if (precise.some((sample) => terrainDataSource(sample) === "CESIUM_WORLD_TERRAIN")) {
      failedBearings += 1;
      completedAttempts += 1;
      const contaminatedCount = precise.filter(
        (sample) => terrainDataSource(sample) === "CESIUM_WORLD_TERRAIN"
      ).length;
      lastFailureReason =
        `GSI高精度DEM未取得(${contaminatedCount}/${precise.length}点がWorld Terrainへフォールバック。` +
        `通信失敗またはジオイド高未確定の可能性)`;
      console.warn(`[bearing-profile] 方位${bearing}°はGSI高精度DEMを取得できずWorld Terrainへフォールバックしたため未完了扱いにします`);
      reportProgress({ totalSteps, completedSteps: completedAttempts, successfulSteps: successfulBearings, failedSteps: failedBearings, lastFailureReason, currentBearingDegrees: bearing, phase: "terrain", terrainStage: "high-precision", profilePoints: totalProfilePoints, highPrecisionPoints: totalHighPrecisionPoints });
      maybeAbortForSystemicFailure();
      return;
    }

    const entry: BearingProfileEntry = {
      bearingDegrees: bearing,
      points: cartographicPoints.map(({ distanceMeters, destination }, i) => ({
        distanceMeters,
        longitude: destination.longitude,
        latitude: destination.latitude,
        ellipsoidalHeightMeters: precise[i].height,
      })),
      computedAtIso: new Date().toISOString(),
    };
    await acceptProfile(entry);

    reportProgress({
      totalSteps,
      completedSteps: completedAttempts,
      successfulSteps: successfulBearings,
      failedSteps: failedBearings,
      currentBearingDegrees: bearing,
      phase: "terrain",
      profilePoints: totalProfilePoints,
      highPrecisionPoints: totalHighPrecisionPoints,
    });
  }

  async function worker(): Promise<void> {
    while (!signal?.aborted && !abortReason) {
      const index = nextIndex;
      if (index >= remainingBearings.length) return;
      nextIndex += 1;
      await processBearing(index);
    }
  }

  const workerCount = Math.min(BEARING_CONCURRENCY, remainingBearings.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (abortReason) {
    resumeDeviceTilePrefetch();
    await finishCapture();
    throw new Error(`${abortReason}（成功${successfulBearings} / 失敗${failedBearings}）`);
  }

  // Foreground DEM work is complete. Persist the queued decoded tiles now, with
  // one global low-priority worker.
  resumeDeviceTilePrefetch();
  if (!signal?.aborted) await flushGsiDeviceTilePrefetchQueue(signal);

  // 2026-09-30: 水面・河川情報とOSM周辺情報（道路・立入・建物）の保存を廃止した。
  // 端末の地理条件キャッシュは「用途＋緯度経度小数5桁（約1m）」が一致したときだけ
  // 読まれるため、方位プロファイル上の間引き点や被写体周辺の固定17地点の保存値は、
  // ライブ探索の候補地点・被写体高さ推定（height-only）のどちらからも実質的に
  // 参照されていなかった。一方で公開Overpassの不安定さによりダウンロード全体を
  // 「一部不足」にしていた。ライブ探索の水面判定はこれまでどおりその場で行う
  // （5秒で打ち切り、失敗しても候補計算は継続）。

  reportProgress({ totalSteps: 1, completedSteps: 1, currentBearingDegrees: null, phase: "finalizing" });
  const captured = await finishCapture();

  return {
    profilePoints: totalProfilePoints,
    highPrecisionPoints: totalHighPrecisionPoints,
    demTileCount: captured.tileCount,
    demTileBytes: captured.bytes,
    storageWriteFailures: captured.writeFailures + (getBearingProfileWriteFailureCount() - bearingProfileWriteFailuresAtStart),
    requestedBearings: totalSteps,
    successfulBearings,
    failedBearings,
    aborted: Boolean(signal?.aborted),
    demTileFailures: captured.downloadFailures,
  };
  } finally {
    resumeDeviceTilePrefetch();
    if (!captureFinished) await finishCapture();
  }
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
  lensCenterHeightMeters: number,
  calculationMode: CalculationMode,
  initialDirectionObserver: GroundPoint | undefined
): number[] {
  // authoritative な calculateTripodCandidates() と同じ方向フレームを使う。
  // 既存三脚がある場合はそのレンズ中心を観測点とし、無い場合だけ被写体の
  // レンズ中心を使う。被写体地点のENUへaz/altをそのまま載せ替えると、
  // 長距離ではECEF方向が本計算とずれて誤って「交点なし」にできる。
  const rayDirectionObserver = initialDirectionObserver ?? withLensCenterHeight(
    subjectPoint,
    lensCenterHeightMeters,
    "方位プロファイル初期方向観測点"
  );
  const initialSubjectElevation = computeApparentElevation(
    rayDirectionObserver,
    subjectPoint,
    calculationMode
  );
  const initialGroundRefractionDegrees =
    initialSubjectElevation.apparentAltitudeDegrees -
    initialSubjectElevation.geometricAltitudeDegrees;
  const geometricRayAltitudeDegrees = altitudeDegrees - initialGroundRefractionDegrees;
  const ray = buildCelestialBackwardRay(
    subjectPoint,
    azimuthDegrees,
    geometricRayAltitudeDegrees,
    rayDirectionObserver
  );
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
    const crossed = previous === 0 || current === 0 || previous * current < 0;
    if (!crossed) continue;
    const distancePrevious = profile.points[index - 1].distanceMeters;
    const distanceCurrent = profile.points[index].distanceMeters;
    const totalMagnitude = Math.abs(previous) + Math.abs(current);
    const t = totalMagnitude > 0 ? Math.abs(previous) / totalMagnitude : 0.5;
    brackets.push(distancePrevious + (distanceCurrent - distancePrevious) * t);
  }

  // 本計算の粗探索と同じ安全策。符号反転が見つからなくても、サンプル間隔の
  // 間に狭い交差が存在する場合があるため、最もレイへ近かった地点を狭域確認へ
  // 渡す。ここでは最終確定せず、後段のcalculateTripodCandidates()が通常どおり
  // 精密化・round-trip検証するため、偽陽性を確定結果にするものではない。
  if (brackets.length === 0) {
    const finiteErrors = errors
      .map((error, index) => ({ error, index }))
      .filter(({ error }) => Number.isFinite(error));
    if (finiteErrors.length === 0) return [];
    const closest = finiteErrors.reduce((best, current) =>
      Math.abs(current.error) < Math.abs(best.error) ? current : best
    );
    return [profile.points[closest.index].distanceMeters];
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
 * 4. キャッシュは高速化専用であり「候補なし」を最終確定する権限は持たない。
 *    符号反転が無ければ最接近点を狭域確認し、それでも確定候補が得られない
 *    場合はnullを返してauthoritativeな通常探索へ必ずフォールバックする。
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
  // 2026-09-30: 補助データ不足で「一部不足」になった既存のダウンロードも、
  // 保存済みプロファイルがあれば使う（有効化フラグが立たなかった旧版の記録を含む）。
  // 必要な方位のプロファイルが無ければ下のgetBearingProfileがnullを返し、
  // 通常探索へ進むため、無条件に参照しても安全。
  if (
    !isBearingProfileEnabled(subjectId) &&
    !listDownloadedSpotData().some((record) => record.subjectId === subjectId && record.profilePoints > 0)
  ) return null;

  const collected: TripodCandidate[] = [];
  let verificationFailures = 0;
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
      cameraSettings.lensCenterHeightMeters,
      calculationMode,
      initialDirectionObserver
    );

    const verifiedForPoint: TripodCandidate[] = [];
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
        verifiedForPoint.push(...verified);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn(
          `[bearing-profile] ${point.label} 距離約${Math.round(approximateDistance)}mの狭域再確認に失敗しました`,
          error
        );
        // この候補だけ諦める。他の候補・他の天体には影響させない。
        verificationFailures += 1;
      }
    }

    // 高速経路で一部の天体だけ候補が得られた状態をcompleteとして返さない。
    // 1天体でも0件なら、その天体に本当に解が無いのかキャッシュが拾えなかった
    // だけなのかを判別できないため、検索全体をauthoritativeな通常探索へ戻す。
    if (verifiedForPoint.length === 0) return null;
    collected.push(...verifiedForPoint);
  }
  // 2026-10-01: 方位プロファイルは高速化専用。狭域再確認で候補が1件も
  // 確定しなかった場合、それが「本当に解なし」なのか「プロファイルの粗さ・
  // 方位量子化・狭域レンジでは拾えなかった」のかはキャッシュだけでは断定
  // できない。空配列を成功結果として返すとApp側がcompleteにして全域探索を
  // 打ち切るため、0件は理由を問わずnullとしてauthoritativeな通常探索へ戻す。
  if (collected.length === 0) {
    if (verificationFailures > 0) {
      console.warn(
        `[bearing-profile] 狭域再確認で確定候補を得られませんでした（失敗${verificationFailures}件）。通常探索へフォールバックします`
      );
    }
    return null;
  }
  return collected;
}
