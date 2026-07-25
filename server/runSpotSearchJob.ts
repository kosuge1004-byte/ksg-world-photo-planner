import { calculateTripodCandidates } from "../src/cesium/tripodCandidates.ts";
import { searchSpotPresets } from "../src/search/spotPresetSearch.ts";
import type { SerializedSpotPresetResult } from "../src/types/backgroundSearch.ts";
import type { CameraSettings } from "../src/types/camera.ts";
import type { SpotSearchJob } from "../src/types/backgroundSearch.ts";
import { createServerLineOfSightEvaluator } from "./celestialTerrainVisibility.ts";
import { fetchServerSiteContexts } from "./siteContext.ts";
import { updateSpotSearchJob } from "./spotSearchJobs.ts";
import { sampleServerWorldTerrain } from "./worldTerrain.ts";
import { prefetchGsiTerrainAroundSubject } from "./gsiElevation.ts";
import { formatSearchDuration, type SpotSearchPerformanceMetrics } from "../src/search/searchPerformance.ts";


function diagnosticSummary(metrics?: SpotSearchPerformanceMetrics): string {
  if (!metrics) return "";
  const c = metrics.counters;
  return [
    "検索診断",
    `日時候補: ${c.generatedSamples}件`,
    `日時確認: ${c.checkedSamples}件`,
    `天体条件通過: ${c.celestialMatches}件`,
    `三脚計算試行: ${c.candidateAttempts}件`,
    `三脚候補成立: ${c.candidateAccepted}件`,
    `三脚計算失敗: ${c.candidateFailures}件`,
    `DEM先行取得失敗: ${c.terrainPrefetchFailures}件`,
    `見通し確認: ${c.lineOfSightChecks}件`,
    `見通し通過: ${c.lineOfSightVisible}件`,
    `見通し取得失敗: ${c.lineOfSightFailures}件`,
    `地形未確認で保留: ${c.lineOfSightUnverifiedAccepted}件`,
    `サーバー候補: ${c.resultCount}件`,
  ].join(" / ");
}

const serverCandidateCalculator: typeof calculateTripodCandidates = (
  subject,
  points,
  lensCenterHeightMeters,
  date,
  calculationMode,
  _unusedTerrainSampler,
  signal,
  previewAspectRatio,
  distanceRange,
  searchProfile
) => calculateTripodCandidates(
  subject,
  points,
  lensCenterHeightMeters,
  date,
  calculationMode,
  sampleServerWorldTerrain,
  signal,
  previewAspectRatio,
  distanceRange,
  searchProfile
);

function serializeResults(
  results: Awaited<ReturnType<typeof searchSpotPresets>>
): SerializedSpotPresetResult[] {
  return results.map((result) => ({
    ...result,
    date: result.date.toISOString(),
  }));
}

type JobUpdate = Partial<Pick<
  SpotSearchJob,
  "status" | "progress" | "progressPercent" | "results" | "error"
>>;

export type SpotSearchJobUpdater = (
  clientId: string,
  jobId: string,
  update: JobUpdate
) => Promise<SpotSearchJob>;

export async function runSpotSearchJob(
  job: SpotSearchJob,
  updateJob: SpotSearchJobUpdater = updateSpotSearchJob
): Promise<void> {
  const { clientId, jobId, input } = job;
  const firstRunNotice = input.cacheState !== "warm"
    ? "初回検索データを準備しています。初回は通常より時間がかかります。作成したデータは次回以降の検索で再利用されます。"
    : "保存済みの検索準備データを利用しています。";
  await updateJob(clientId, jobId, {
    status: "running",
    progress: firstRunNotice,
    progressPercent: 0,
    error: undefined,
  });

  let progressQueue = Promise.resolve();
  let lastProgressWrite = 0;
  const saveProgress = (message: string, progressPercent: number): void => {
    const now = Date.now();
    if (now - lastProgressWrite < 750) return;
    lastProgressWrite = now;
    progressQueue = progressQueue
      .catch(() => undefined)
      .then(() => updateJob(clientId, jobId, {
        progress: progressPercent < 96 ? `${message}\n${firstRunNotice}` : message,
        progressPercent,
      }))
      .then(() => undefined);
  };

  try {
    let performanceMetrics: SpotSearchPerformanceMetrics | undefined;
    // スポット検索画面で指定した焦点距離を必ず検索計算へ使用する。
    // 以前はメイン画面の cameraSettings.focalLengthMm が優先され、
    // 検索画面で24mmを指定してもメイン画面が望遠なら望遠条件で計算されていた。
    const cameraSettings: CameraSettings = {
      ...(input.cameraSettings ?? {}),
      focalLengthMm: input.criteria.focalLengthMm,
      lensCenterHeightMeters:
        input.cameraSettings?.lensCenterHeightMeters ?? input.lensCenterHeightMeters,
    };
    const results = await searchSpotPresets({
      criteria: input.criteria,
      subject: input.subject,
      baseDate: new Date(input.baseDateIso),
      timeZone: input.timeZone,
      cameraSettings,
      previewAspectRatio: input.previewAspectRatio ?? 3 / 2,
      subjectGroundHeightMeters: input.subjectGroundHeightMeters,
      calculationMode: input.calculationMode,
      onProgress: saveProgress,
      onPerformance: (metrics) => {
        performanceMetrics = metrics;
        console.info(`[spot-search-performance:${jobId}]`, metrics);
      },
      lineOfSightEvaluator: createServerLineOfSightEvaluator(
        input.lensCenterHeightMeters
      ),
      candidateCalculator: serverCandidateCalculator,
      siteContextFetcher: fetchServerSiteContexts,
      terrainPrefetcher: async (prefetchSubject, azimuthBand, maximumDistanceMeters, signal) => {
        await prefetchGsiTerrainAroundSubject(
          prefetchSubject.latitude,
          prefetchSubject.longitude,
          maximumDistanceMeters,
          24,
          12,
          signal,
          azimuthBand
        );
      },
    });
    await progressQueue;
    await updateJob(clientId, jobId, {
      status: "awaiting-3d",
      progressPercent: 98,
      progress: results.length > 0
        ? `端末復帰後に建物の最終3D遮蔽を確認します…${performanceMetrics ? `\n検索計算 ${formatSearchDuration(performanceMetrics.totalMilliseconds)}\n${diagnosticSummary(performanceMetrics)}` : ""}`
        : `条件に一致する候補はありませんでした${performanceMetrics ? `\n検索計算 ${formatSearchDuration(performanceMetrics.totalMilliseconds)}\n${diagnosticSummary(performanceMetrics)}` : ""}`,
      results: serializeResults(results),
    });
  } catch (error) {
    await progressQueue.catch(() => undefined);
    await updateJob(clientId, jobId, {
      status: "failed",
      progress: "検索に失敗しました",
      progressPercent: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
