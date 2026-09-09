import type {
  BearingProfileDownloadJob,
  BearingProfileDownloadJobInput,
} from "../src/types/backgroundBearingProfile.ts";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
// 360方位ぶんを1要求で送るとKV/Queueメッセージが不必要に大きくなるため、
// 端末側で分割して投入することを想定した上限（spotSearchJobsのMAX_QUERY_LENGTH
// と同じ考え方で、想定外に巨大な入力をここで弾く）。
const MAX_PENDING_BEARINGS = 360;

export type BearingProfileDownloadJobKv = {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: Record<string, unknown> }
  ): Promise<void>;
};

export type BearingProfileDownloadQueueMessage = {
  version: 1;
  job: BearingProfileDownloadJob;
};

export type KvWriteDiagnosticContext = {
  source: string;
  requestId?: string;
  queueAttempt?: number;
};

type JobUpdate = Partial<Pick<
  BearingProfileDownloadJob,
  "status" | "progress" | "progressPercent" | "profiles" |
  "waterSiteContextPoints" | "waterSiteContexts" |
  "fullSiteContextPoints" | "fullSiteContexts" | "error"
>>;

export function validBearingJobId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidGroundPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isFiniteNumber(point.latitude) && point.latitude >= -90 && point.latitude <= 90 &&
    isFiniteNumber(point.longitude) && point.longitude >= -180 && point.longitude <= 180 &&
    isFiniteNumber(point.height);
}

function isValidCameraSettings(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return isFiniteNumber(settings.lensCenterHeightMeters);
}

export function validBearingProfileDownloadJobInput(
  value: unknown
): value is BearingProfileDownloadJobInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.subjectId !== "string" || input.subjectId.length === 0 || input.subjectId.length > 200) {
    return false;
  }
  if (!isValidGroundPoint(input.subjectPoint)) return false;
  if (!isValidCameraSettings(input.cameraSettings)) return false;
  if (!Array.isArray(input.pendingBearings) || input.pendingBearings.length === 0 ||
    input.pendingBearings.length > MAX_PENDING_BEARINGS) {
    return false;
  }
  return input.pendingBearings.every((bearing) =>
    isFiniteNumber(bearing) && bearing >= 0 && bearing < 360
  );
}

function key(clientId: string, jobId: string): string {
  if (!validBearingJobId(clientId) || !validBearingJobId(jobId)) {
    throw new Error("ダウンロードジョブIDが不正です");
  }
  return `bearing-profile-download-jobs/v1/${clientId}/${jobId}.json`;
}

function isBearingProfileDownloadJob(value: unknown): value is BearingProfileDownloadJob {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "clientId" in value && validBearingJobId(value.clientId) &&
    "jobId" in value && validBearingJobId(value.jobId) &&
    "status" in value && typeof value.status === "string" &&
    "input" in value && typeof value.input === "object" && value.input !== null &&
    "profiles" in value && Array.isArray(value.profiles);
}

function persistedJobSignature(job: BearingProfileDownloadJob): string {
  return JSON.stringify({
    status: job.status,
    profileCount: job.profiles.length,
    error: job.error,
  });
}

export async function getBearingProfileDownloadJob(
  kv: BearingProfileDownloadJobKv,
  clientId: string,
  jobId: string
): Promise<BearingProfileDownloadJob | null> {
  const value = await kv.get(key(clientId, jobId), { type: "json" });
  return isBearingProfileDownloadJob(value) ? value : null;
}

export async function setBearingProfileDownloadJob(
  kv: BearingProfileDownloadJobKv,
  job: BearingProfileDownloadJob,
  diagnostic?: KvWriteDiagnosticContext
): Promise<void> {
  const kvKey = key(job.clientId, job.jobId);
  const logEntry = {
    event: "workers_kv_put",
    namespace: "BEARING_PROFILE_DOWNLOAD_JOBS",
    key: kvKey,
    source: diagnostic?.source ?? "unknown",
    requestId: diagnostic?.requestId,
    queueAttempt: diagnostic?.queueAttempt,
    clientId: job.clientId,
    jobId: job.jobId,
    status: job.status,
    profileCount: job.profiles.length,
    hasError: Boolean(job.error),
    updatedAt: job.updatedAt,
  };
  try {
    await kv.put(kvKey, JSON.stringify(job), {
      expirationTtl: JOB_TTL_SECONDS,
      metadata: { status: job.status, updatedAt: job.updatedAt },
    });
    console.info(JSON.stringify({ ...logEntry, outcome: "success" }));
  } catch (error) {
    console.error(JSON.stringify({
      ...logEntry,
      event: "workers_kv_put_failed",
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

/**
 * Queue Consumer内で使う更新関数。spotSearchJobsのcreateSpotSearchJobUpdaterと
 * 同じ考え方で、進捗率・進捗文言だけの更新はKVへ書き込まず（無料枠のKV書き込み
 * 回数を圧迫しないため）、statusまたはprofiles/errorが変わった時だけ永続化する。
 */
export function createBearingProfileDownloadJobUpdater(
  kv: BearingProfileDownloadJobKv,
  initialJob: BearingProfileDownloadJob,
  diagnostic?: KvWriteDiagnosticContext
): (update: JobUpdate) => Promise<BearingProfileDownloadJob> {
  let current = initialJob;
  let lastPersistedSignature = persistedJobSignature(initialJob);
  return async (update) => {
    current = { ...current, ...update, updatedAt: new Date().toISOString() };
    const hasPersistentField =
      update.status !== undefined || update.profiles !== undefined || update.error !== undefined;
    const nextSignature = persistedJobSignature(current);
    if (hasPersistentField && nextSignature !== lastPersistedSignature) {
      await setBearingProfileDownloadJob(kv, current, diagnostic);
      lastPersistedSignature = nextSignature;
    }
    return current;
  };
}
