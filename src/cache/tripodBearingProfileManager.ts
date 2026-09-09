import {
  ABSOLUTE_MAX_DISTANCE_METERS,
  ABSOLUTE_MIN_DISTANCE_METERS,
  buildCelestialBackwardRay,
  calculateTripodCandidates,
  rayCartographicAtDistance,
} from "../cesium/tripodCandidates";
import { beginGsiDeviceTileCapture, finishGsiDeviceTileCapture, recordGsiDeviceTileReferencesForPoints } from "../cesium/gsiDemTileCache";
import { idFor } from "../subjectStorage";
import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { RefractionWeatherContext } from "../search/refractionWeatherModel";
import { isAbortError } from "../utils/runtimeErrors";
import { writePersistentSiteContexts } from "./siteContextPersistentCache";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { deviceClientId, newId } from "../search/backgroundSpotSearch";
import type {
  BearingProfileDownloadJob,
  BearingProfileDownloadJobInput,
} from "../types/backgroundBearingProfile";
import {
  BEARING_STEP_DEGREES,
  clearBearingProfileCacheForSubject,
  getBearingProfile,
  roundCameraHeightForCacheKey,
  setBearingProfile,
  type BearingProfileEntry,
} from "./tripodBearingProfileCache";

/**
 * 2026-09-05追記（全面設計変更）: 「方位ごとに実測地形プロファイルを保存し、
 * 高度（＝時刻）に関わらずどのパターンでも使い回す」方式。詳しい経緯は
 * tripodBearingProfileCache.tsの冒頭コメント参照。
 *
 * 2026-09-08追記（サーバー側バックグラウンドジョブ化）: 実際の360方位ぶんの
 * 地形取得・水面判定・OSM周辺情報取得は、ブラウザ/WebViewのJS実行に依存する
 * 限り「タブ/アプリを閉じたら止まる」という制約から逃れられない。これは
 * 全ブラウザベンダーが意図的にそう設計しており、回避策は存在しない。
 * そこでspotSearchJob（既存の「スポット検索」機能）と同じ設計で、実際の
 * 重い処理はCloudflare Worker（Queue Consumer）側で実行し、端末は
 * 「開始」「進捗確認（ポーリング）」「完了データの受信・端末保存」の
 * 3ステップだけを担う。これによりWebでもタブ/アプリを完全に閉じている間
 * サーバー側で処理が進み、次回アプリを開いた時に自動で完成データを取り込める。
 * サーバー側で完結するこの設計は、将来Capacitorでネイティブ化した際も
 * Android/iOSそれぞれのバックグラウンド実行制限（Foreground Service /
 * BGProcessingTask等）を一切必要としない。
 */

/** 全方位を覆う刻み幅。tripodBearingProfileCache.tsのBEARING_STEP_DEGREESと同じ値。 */
export const ALL_BEARINGS_STEP_DEGREES = BEARING_STEP_DEGREES;
const TOTAL_BEARINGS = Math.round(360 / ALL_BEARINGS_STEP_DEGREES);

const OPT_IN_STORAGE_KEY = "ksg-tripod-bearing-profile-subjects-v1";
const ACTIVE_DOWNLOAD_JOBS_KEY = "ksg-bearing-profile-download-active-jobs-v1";
// Workers KVの結果整合性反映待ちの猶予（waitForBackgroundSpotSearchと同じ考え方）。
const MISSING_JOB_GRACE_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

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
  /**
   * 2026-09-08追記: サーバー側ジョブが返す人間可読な進捗文言（例:
   * 「地形プロファイルを取得しています（12/48方位）」）。設定されている
   * 場合、BearingProfileDownloadDialogはこちらを優先して表示する。
   */
  serverMessage?: string;
};

export type BearingBackfillResult = {
  profilePoints: number;
  highPrecisionPoints: number;
  demTileCount: number;
  demTileBytes: number;
  storageWriteFailures: number;
};

type ActiveDownloadJobMap = Record<string, { jobId: string; createdAtIso: string }>;

function activeDownloadJobKey(subjectId: string, cameraHeightMeters: number): string {
  return `${subjectId}:${roundCameraHeightForCacheKey(cameraHeightMeters)}`;
}

function readActiveDownloadJobs(): ActiveDownloadJobMap {
  try {
    const raw = localStorage.getItem(ACTIVE_DOWNLOAD_JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? parsed as ActiveDownloadJobMap : {};
  } catch {
    return {};
  }
}

function saveActiveDownloadJob(key: string, jobId: string): void {
  const jobs = readActiveDownloadJobs();
  jobs[key] = { jobId, createdAtIso: new Date().toISOString() };
  localStorage.setItem(ACTIVE_DOWNLOAD_JOBS_KEY, JSON.stringify(jobs));
}

function clearActiveDownloadJob(key: string): void {
  const jobs = readActiveDownloadJobs();
  if (jobs[key]) {
    delete jobs[key];
    localStorage.setItem(ACTIVE_DOWNLOAD_JOBS_KEY, JSON.stringify(jobs));
  }
}

async function errorMessageFrom(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {
    // JSON以外のエラー応答ではHTTPステータスを表示する。
  }
  return `ダウンロードAPIエラー：${response.status}`;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("ダウンロードの待機を中止しました", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("ダウンロードの待機を中止しました", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
    const existing = await getBearingProfile(subjectId, cameraSettings.lensCenterHeightMeters, bearing);
    if (forceRefresh || !existing) pendingBearings.push(bearing);
  }

  const totalSteps = pendingBearings.length;
  onProgress?.({ totalSteps, completedSteps: 0, currentBearingDegrees: null, phase: "terrain" });
  if (totalSteps === 0) {
    const captured = await finishGsiDeviceTileCapture(subjectId);
    return { profilePoints: 0, highPrecisionPoints: 0, demTileCount: captured.tileCount, demTileBytes: captured.bytes, storageWriteFailures: captured.writeFailures };
  }

  // サーバー側バックグラウンドジョブを開始/再開する。同じ被写体・同じカメラ高
  // であれば、アプリを閉じて再度開いた場合でも同じジョブIDに再接続し、
  // 重複してジョブを起動しない（既存のstartBackgroundSpotSearchと同じ設計）。
  const clientId = deviceClientId();
  const activeKey = activeDownloadJobKey(subjectId, cameraSettings.lensCenterHeightMeters);
  const existingActive = readActiveDownloadJobs()[activeKey];
  const jobId = existingActive?.jobId ?? newId();
  if (!existingActive) saveActiveDownloadJob(activeKey, jobId);

  const input: BearingProfileDownloadJobInput = {
    subjectId,
    subjectPoint,
    cameraSettings,
    pendingBearings,
  };

  try {
    const startResponse = await diagnosticFetch(
      "bearing-profile-download",
      "/api/bearing-profile-download-start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ clientId, jobId, input }),
        signal,
      },
      15_000
    );
    if (!startResponse.ok) throw new Error(await errorMessageFrom(startResponse));
  } catch (error) {
    clearActiveDownloadJob(activeKey);
    throw error;
  }

  const waitStartedAt = Date.now();
  let job: BearingProfileDownloadJob;
  while (true) {
    if (signal?.aborted) {
      // ユーザーが中断してもサーバー側のジョブ自体は止めない。次にこの被写体の
      // ダウンロードを開くと、activeKeyから同じジョブへ再接続し進捗を引き継ぐ。
      throw new DOMException("ダウンロードの確認を中止しました", "AbortError");
    }
    const query = new URLSearchParams({ clientId, jobId });
    const statusResponse = await diagnosticFetch(
      "bearing-profile-download",
      `/api/bearing-profile-download-status?${query}`,
      { headers: { Accept: "application/json" }, cache: "no-store", signal },
      15_000
    );
    if (statusResponse.status === 404) {
      const elapsed = Date.now() - waitStartedAt;
      if (elapsed < MISSING_JOB_GRACE_MS) {
        onProgress?.({
          totalSteps,
          completedSteps: 0,
          currentBearingDegrees: null,
          phase: "terrain",
          serverMessage: `ダウンロードジョブの起動を確認中（${Math.floor(elapsed / 1000)}秒）`,
        });
        await abortableDelay(POLL_INTERVAL_MS, signal);
        continue;
      }
      clearActiveDownloadJob(activeKey);
      throw new Error("ダウンロードジョブが見つかりませんでした。もう一度お試しください");
    }
    if (!statusResponse.ok) throw new Error(await errorMessageFrom(statusResponse));
    job = await statusResponse.json() as BearingProfileDownloadJob;
    onProgress?.({
      totalSteps,
      completedSteps: Math.round((Math.max(0, Math.min(100, job.progressPercent)) / 100) * totalSteps),
      currentBearingDegrees: null,
      phase: "terrain",
      serverMessage: job.progress,
    });
    if (job.status === "complete" || job.status === "failed") break;
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }

  clearActiveDownloadJob(activeKey);
  if (job.status === "failed") {
    throw new Error(job.error ?? "ダウンロードに失敗しました");
  }

  // サーバーが計算した結果を、既存のIndexedDBキャッシュへそのまま書き込む。
  // 形状はtripodBearingProfileCache.BearingProfileEntryと完全に一致するため、
  // 読み出し側（tryUseBearingProfileCache）は変更不要。
  onProgress?.({ totalSteps: 1, completedSteps: 0, currentBearingDegrees: null, phase: "finalizing", serverMessage: "端末への保存を確定しています…" });
  for (const profile of job.profiles) {
    const entry: BearingProfileEntry = {
      bearingDegrees: profile.bearingDegrees,
      points: profile.points,
      computedAtIso: profile.computedAtIso,
    };
    await setBearingProfile(subjectId, cameraSettings.lensCenterHeightMeters, profile.bearingDegrees, entry);
  }
  // 2026-09-08追記: 実際のDEMタイル取得はまだサーバー側では行わないが、
  // 「このダウンロード済みスポットがどのタイルに関係するか」の参照だけは
  // ここで記録しておく。これにより、共有タイル安全削除
  // （deleteGsiDeviceTilesForDownloadedSpot）の対象判定が正しく機能する。
  // 実タイル本体は、この後の通常のライブ操作（プレビュー・三脚探索）で
  // 触れた時点で通常どおりIndexedDBへ実体が保存される。
  for (const profile of job.profiles) {
    recordGsiDeviceTileReferencesForPoints(subjectId, profile.points);
  }
  try {
    if (job.waterSiteContextPoints.length > 0) {
      await writePersistentSiteContexts(
        job.waterSiteContextPoints,
        job.waterSiteContexts,
        "water-only",
        false,
        subjectId
      );
    }
    if (job.fullSiteContextPoints.length > 0) {
      await writePersistentSiteContexts(
        job.fullSiteContextPoints,
        job.fullSiteContexts,
        "full",
        true,
        subjectId
      );
    }
  } catch (error) {
    console.warn("[bearing-profile] サーバー取得済み周辺情報の端末保存に失敗しました", error);
  }
  onProgress?.({ totalSteps: 1, completedSteps: 1, currentBearingDegrees: null, phase: "finalizing" });
  const captured = await finishGsiDeviceTileCapture(subjectId);

  return {
    profilePoints: job.profiles.reduce((sum, profile) => sum + profile.points.length, 0),
    highPrecisionPoints: job.profiles.reduce((sum, profile) => sum + profile.points.length, 0),
    demTileCount: captured.tileCount,
    demTileBytes: captured.bytes,
    storageWriteFailures: captured.writeFailures,
  };
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
