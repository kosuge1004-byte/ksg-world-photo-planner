import { calculateTripodCandidates } from "../src/cesium/tripodCandidates.ts";
import { searchSpotPresets } from "../src/search/spotPresetSearch.ts";
import type { SerializedSpotPresetResult } from "../src/types/backgroundSearch.ts";
import type { CameraSettings } from "../src/types/camera.ts";
import type { SpotSearchJob } from "../src/types/backgroundSearch.ts";
import { createServerLineOfSightEvaluator } from "./celestialTerrainVisibility.ts";
import { fetchServerSiteContexts } from "./siteContext.ts";
import { updateSpotSearchJob } from "./spotSearchJobs.ts";
import { sampleServerWorldTerrain } from "./worldTerrain.ts";

const serverCandidateCalculator: typeof calculateTripodCandidates = (
  subject,
  points,
  lensCenterHeightMeters,
  date,
  calculationMode,
  _unusedTerrainSampler,
  signal,
  previewAspectRatio,
  distanceRange
) => calculateTripodCandidates(
  subject,
  points,
  lensCenterHeightMeters,
  date,
  calculationMode,
  sampleServerWorldTerrain,
  signal,
  previewAspectRatio,
  distanceRange
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
  "status" | "progress" | "results" | "error"
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
  await updateJob(clientId, jobId, {
    status: "running",
    progress: "サーバーで天体位置を検索しています…",
    error: undefined,
  });

  let progressQueue = Promise.resolve();
  let lastProgressWrite = 0;
  const saveProgress = (message: string): void => {
    const now = Date.now();
    if (now - lastProgressWrite < 750) return;
    lastProgressWrite = now;
    progressQueue = progressQueue
      .catch(() => undefined)
      .then(() => updateJob(clientId, jobId, { progress: message }))
      .then(() => undefined);
  };

  try {
    const cameraSettings: CameraSettings = input.cameraSettings ?? {
      focalLengthMm: 24,
      lensCenterHeightMeters: input.lensCenterHeightMeters,
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
      lineOfSightEvaluator: createServerLineOfSightEvaluator(
        input.lensCenterHeightMeters
      ),
      candidateCalculator: serverCandidateCalculator,
      siteContextFetcher: fetchServerSiteContexts,
    });
    await progressQueue;
    await updateJob(clientId, jobId, {
      status: "awaiting-3d",
      progress: results.length > 0
        ? "端末復帰後に建物の最終3D遮蔽を確認します…"
        : "条件に一致する候補はありませんでした",
      results: serializeResults(results),
    });
  } catch (error) {
    await progressQueue.catch(() => undefined);
    await updateJob(clientId, jobId, {
      status: "failed",
      progress: "検索に失敗しました",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
