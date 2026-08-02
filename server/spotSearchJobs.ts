import type {
  SerializedSpotPresetResult,
  SpotSearchJob,
  SpotSearchJobInput,
} from "../src/types/backgroundSearch.ts";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

export type SpotSearchStorageStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StoredSpotSearchJob = {
  version: 1;
  jobId: string;
  status: SpotSearchStorageStatus;
  progress: string;
  progressPercent?: number;
  createdAt: string;
  updatedAt: string;
  request: SpotSearchJobInput;
  partialResult: SerializedSpotPresetResult[];
  finalResult?: SerializedSpotPresetResult[];
  error?: string;
  expiresAt: string;
  /** 既存の公開APIレスポンスを変更せず保持する。 */
  job: SpotSearchJob;
};

export type SpotSearchJobKv = {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: {
      expirationTtl?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void>;
};

type JobUpdate = Partial<Pick<
  SpotSearchJob,
  "status" | "progress" | "progressPercent" | "results" | "error"
>>;

export type SpotSearchQueueMessage = {
  version: 1;
  job: SpotSearchJob;
};

export function validSearchJobId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function validSpotSearchJobInput(
  value: unknown
): value is SpotSearchJobInput {
  if (typeof value !== "object" || value === null) return false;
  if (!("criteria" in value) || typeof value.criteria !== "object" || value.criteria === null) {
    return false;
  }
  if (!("subject" in value) || typeof value.subject !== "object" || value.subject === null) {
    return false;
  }
  return "baseDateIso" in value && typeof value.baseDateIso === "string" &&
    Number.isFinite(Date.parse(value.baseDateIso)) &&
    "timeZone" in value && typeof value.timeZone === "string" && value.timeZone.length <= 80 &&
    "lensCenterHeightMeters" in value && Number.isFinite(value.lensCenterHeightMeters) &&
    "subjectGroundHeightMeters" in value && Number.isFinite(value.subjectGroundHeightMeters) &&
    "calculationMode" in value &&
      (value.calculationMode === "standard" || value.calculationMode === "pro");
}

function key(clientId: string, jobId: string): string {
  if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
    throw new Error("検索ジョブIDが不正です");
  }
  return `spot-search-jobs/v1/${clientId}/${jobId}.json`;
}

function isSpotSearchJob(value: unknown): value is SpotSearchJob {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "clientId" in value && validSearchJobId(value.clientId) &&
    "jobId" in value && validSearchJobId(value.jobId) &&
    "status" in value && typeof value.status === "string" &&
    "input" in value && typeof value.input === "object" && value.input !== null &&
    "results" in value && Array.isArray(value.results);
}

function storageStatus(job: SpotSearchJob): SpotSearchStorageStatus {
  if (job.status === "complete") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "queued") return "queued";
  return "running";
}

function storedRecord(
  job: SpotSearchJob,
  previous?: StoredSpotSearchJob
): StoredSpotSearchJob {
  const expiresAt = new Date(
    Date.parse(job.updatedAt) + JOB_TTL_SECONDS * 1_000
  ).toISOString();
  const completed = job.status === "complete";
  return {
    version: 1,
    jobId: job.jobId,
    status: storageStatus(job),
    progress: job.progress,
    progressPercent: job.progressPercent,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    request: job.input,
    partialResult: completed
      ? previous?.partialResult ?? previous?.job.results ?? []
      : job.results,
    finalResult: completed ? job.results : undefined,
    error: job.error,
    expiresAt,
    job,
  };
}

function isStoredSpotSearchJob(value: unknown): value is StoredSpotSearchJob {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "job" in value && isSpotSearchJob(value.job);
}

export async function getStoredSpotSearchJob(
  kv: SpotSearchJobKv,
  clientId: string,
  jobId: string
): Promise<StoredSpotSearchJob | null> {
  const value = await kv.get(key(clientId, jobId), { type: "json" });
  return isStoredSpotSearchJob(value) ? value : null;
}

export async function getSpotSearchJob(
  kv: SpotSearchJobKv,
  clientId: string,
  jobId: string
): Promise<SpotSearchJob | null> {
  return (await getStoredSpotSearchJob(kv, clientId, jobId))?.job ?? null;
}

export async function setSpotSearchJob(
  kv: SpotSearchJobKv,
  job: SpotSearchJob,
  previous?: StoredSpotSearchJob
): Promise<void> {
  const record = storedRecord(job, previous);
  await kv.put(key(job.clientId, job.jobId), JSON.stringify(record), {
    expirationTtl: JOB_TTL_SECONDS,
    metadata: {
      status: record.status,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    },
  });
}

export async function updateSpotSearchJob(
  kv: SpotSearchJobKv,
  clientId: string,
  jobId: string,
  update: JobUpdate
): Promise<SpotSearchJob> {
  const currentRecord = await getStoredSpotSearchJob(kv, clientId, jobId);
  if (!currentRecord) throw new Error("検索ジョブが見つかりません");
  const current = currentRecord.job;
  const next: SpotSearchJob = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  await setSpotSearchJob(kv, next, currentRecord);
  return next;
}

/**
 * Queue Consumer内ではローカルの最新版を更新し続ける。
 * Workers KVの結果整合性による進捗の巻き戻りを防ぐために使用する。
 */
export function createSpotSearchJobUpdater(
  kv: SpotSearchJobKv,
  initialJob: SpotSearchJob
): (
  clientId: string,
  jobId: string,
  update: JobUpdate
) => Promise<SpotSearchJob> {
  let current = initialJob;
  return async (clientId, jobId, update) => {
    if (clientId !== current.clientId || jobId !== current.jobId) {
      throw new Error("検索ジョブIDが一致しません");
    }
    current = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    await setSpotSearchJob(kv, current);
    return current;
  };
}
