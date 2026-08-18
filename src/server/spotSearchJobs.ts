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

export type KvWriteDiagnosticContext = {
  source: string;
  requestId?: string;
  queueAttempt?: number;
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

function persistedJobSignature(job: SpotSearchJob): string {
  return JSON.stringify({
    status: job.status,
    results: job.results,
    error: job.error,
  });
}

/**
 * Workers KVへ永続化する状態を、外部プロセスとの受け渡しに必要な
 * チェックポイントだけに限定する。
 *
 * queued: Queueへ渡したジョブの初期状態
 * awaiting-3d: サーバー検索結果を端末へ引き渡す状態
 * failed: エラー復旧に必要な最終状態
 *
 * running と進捗表示はQueue Consumer内のメモリだけで管理し、
 * 時間変更・候補更新・進捗通知によるPUTを発生させない。
 */
function shouldPersistJob(job: SpotSearchJob): boolean {
  return job.status === "queued" ||
    job.status === "awaiting-3d" ||
    job.status === "failed";
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
  previous?: StoredSpotSearchJob,
  diagnostic?: KvWriteDiagnosticContext
): Promise<void> {
  const record = storedRecord(job, previous);
  const kvKey = key(job.clientId, job.jobId);
  const logEntry = {
    event: "workers_kv_put",
    namespace: "SPOT_SEARCH_JOBS",
    key: kvKey,
    source: diagnostic?.source ?? "unknown",
    requestId: diagnostic?.requestId,
    queueAttempt: diagnostic?.queueAttempt,
    clientId: job.clientId,
    jobId: job.jobId,
    previousStatus: previous?.job.status,
    nextStatus: job.status,
    storageStatus: record.status,
    resultCount: job.results.length,
    hasError: Boolean(job.error),
    updatedAt: record.updatedAt,
  };
  try {
    await kv.put(kvKey, JSON.stringify(record), {
      expirationTtl: JOB_TTL_SECONDS,
      metadata: {
        status: record.status,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
      },
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

export async function updateSpotSearchJob(
  kv: SpotSearchJobKv,
  clientId: string,
  jobId: string,
  update: JobUpdate,
  diagnostic?: KvWriteDiagnosticContext
): Promise<SpotSearchJob> {
  const currentRecord = await getStoredSpotSearchJob(kv, clientId, jobId);
  if (!currentRecord) throw new Error("検索ジョブが見つかりません");
  const current = currentRecord.job;
  const next: SpotSearchJob = {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  if (shouldPersistJob(next) &&
    persistedJobSignature(next) !== persistedJobSignature(current)) {
    await setSpotSearchJob(kv, next, currentRecord, diagnostic);
  }
  return next;
}

/**
 * Queue Consumer内ではローカルの最新版を更新し続ける。
 * Workers KVの結果整合性による進捗の巻き戻りを防ぐために使用する。
 */
export function createSpotSearchJobUpdater(
  kv: SpotSearchJobKv,
  initialJob: SpotSearchJob,
  diagnostic?: KvWriteDiagnosticContext
): (
  clientId: string,
  jobId: string,
  update: JobUpdate
) => Promise<SpotSearchJob> {
  let current = initialJob;
  let lastPersistedSignature = persistedJobSignature(initialJob);
  return async (clientId, jobId, update) => {
    if (clientId !== current.clientId || jobId !== current.jobId) {
      throw new Error("検索ジョブIDが一致しません");
    }
    current = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };

    // 検索ループ中の進捗通知はQueue Consumer内のメモリだけで保持する。
    // Workers KVへ保存するのは状態遷移・結果・エラーだけに限定し、
    // 進捗率やメッセージ更新ごとのPUTを発生させない。
    const hasPersistentField =
      update.status !== undefined ||
      update.results !== undefined ||
      update.error !== undefined;
    const nextSignature = persistedJobSignature(current);
    const shouldPersist = shouldPersistJob(current) &&
      hasPersistentField &&
      nextSignature !== lastPersistedSignature;
    if (shouldPersist) {
      await setSpotSearchJob(kv, current, undefined, diagnostic);
      lastPersistedSignature = nextSignature;
    }
    return current;
  };
}
