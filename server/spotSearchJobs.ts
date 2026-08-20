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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidLatitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -180 && value <= 180;
}

const SUN_SEARCH_TIMINGS = new Set(["all", "sunrise", "sunset", "sunrise-sunset"]);
const SEARCH_CELESTIAL_IDS = new Set(["sun", "moon", "milkyWay"]);
const SPOT_SEARCH_PERIODS = new Set(["1-month", "3-months", "6-months", "1-year", "custom"]);
const SPOT_SEARCH_INTERVALS = new Set([
  "1-minute", "5-minutes", "10-minutes", "15-minutes", "30-minutes",
  "1-hour", "1-day", "1-week", "1-month",
]);
const SPOT_SEARCH_DISPLAY_COUNTS = new Set([1, 3, 5, 10, 20, 50, 100]);
// 通常のスポット名・地名は長くても数十〜100文字程度に収まる。
const MAX_QUERY_LENGTH = 300;

/**
 * criteria/subjectがobject型であることまでしか見ていなかった検証を、
 * 実際に使う全フィールドの型・値域チェックへ強化する（B-21）。
 * 公開API（spot-search-start）へ渡る値のため、想定外のフィールド値が
 * 下流のCesium/DEM/Overpass処理まで到達しないようここで弾く。
 */
function isValidSpotSearchCriteria(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.query !== "string" || c.query.length > MAX_QUERY_LENGTH) return false;
  if (typeof c.useCurrentSubjectPin !== "boolean") return false;
  if (!SEARCH_CELESTIAL_IDS.has(c.celestialId as string)) return false;
  if (!SUN_SEARCH_TIMINGS.has(c.sunSearchTiming as string)) return false;
  if (!isFiniteNumber(c.moonAgeMinDays) || !isFiniteNumber(c.moonAgeMaxDays)) return false;
  if (!isFiniteNumber(c.focalLengthMm) || c.focalLengthMm <= 0 || c.focalLengthMm > 5000) return false;
  if (!isFiniteNumber(c.tripodDistanceMinMeters) || !isFiniteNumber(c.tripodDistanceMaxMeters)) return false;
  if (!SPOT_SEARCH_PERIODS.has(c.period as string)) return false;
  if (typeof c.customStartDate !== "string" || typeof c.customEndDate !== "string") return false;
  if (!Array.isArray(c.weekdays) || !c.weekdays.every((day) => typeof day === "number" && day >= 0 && day <= 6)) {
    return false;
  }
  if (c.startTime !== undefined && typeof c.startTime !== "string") return false;
  if (c.endTime !== undefined && typeof c.endTime !== "string") return false;
  if (!SPOT_SEARCH_INTERVALS.has(c.interval as string)) return false;
  if (!SPOT_SEARCH_DISPLAY_COUNTS.has(c.displayCount as number)) return false;
  const constraints = c.siteConstraints as Record<string, unknown> | undefined;
  if (
    typeof constraints !== "object" || constraints === null ||
    typeof constraints.walkingOnly !== "boolean" ||
    typeof constraints.roadsAndPathsOnly !== "boolean" ||
    typeof constraints.excludePrivateAccess !== "boolean" ||
    typeof constraints.elevationDifferenceWithin100m !== "boolean" ||
    typeof constraints.excludeRoads !== "boolean"
  ) {
    return false;
  }
  return true;
}

function isValidSubjectGroundPoint(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isValidLatitude(point.latitude) &&
    isValidLongitude(point.longitude) &&
    isFiniteNumber(point.height) &&
    typeof point.label === "string";
}

export function validSpotSearchJobInput(
  value: unknown
): value is SpotSearchJobInput {
  if (typeof value !== "object" || value === null) return false;
  if (!("criteria" in value) || !isValidSpotSearchCriteria(value.criteria)) {
    return false;
  }
  if (!("subject" in value) || !isValidSubjectGroundPoint(value.subject)) {
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
