import type {
  SerializedSpotPresetResult,
  SpotSearchJob,
  SpotSearchJobInput,
} from "../types/backgroundSearch";
import type { SpotPresetResult } from "../types/search";
import {
  markPreparedSearchCache,
  preparedSearchCacheState,
} from "./preparedSearchCache";

const CLIENT_ID_KEY = "ksg-spot-search-client-id-v1";
const ACTIVE_JOB_KEY = "ksg-active-spot-search-v1";

export function spotSearchPreparationKey(input: Pick<SpotSearchJobInput,
  "subject" | "criteria" | "calculationMode" | "baseDateIso" | "timeZone" |
  "lensCenterHeightMeters" | "cameraSettings" | "previewAspectRatio" |
  "subjectGroundHeightMeters" | "viewCorrection" | "precisionSettings"
>): string {
  // 条件の一部だけを丸めた旧キーでは、ピン・日時・焦点距離・精度設定の変更後も
  // warm扱いになるため、検索と投影へ影響する全スナップショットを含める。
  return JSON.stringify({
    version: 3,
    subject: {
      latitude: input.subject.latitude,
      longitude: input.subject.longitude,
      height: input.subject.height,
    },
    subjectGroundHeightMeters: input.subjectGroundHeightMeters,
    baseDateIso: input.baseDateIso,
    timeZone: input.timeZone,
    criteria: input.criteria,
    calculationMode: input.calculationMode,
    lensCenterHeightMeters: input.lensCenterHeightMeters,
    cameraSettings: input.cameraSettings,
    previewAspectRatio: input.previewAspectRatio,
    viewCorrection: input.viewCorrection,
    precisionSettings: input.precisionSettings,
  });
}

export function spotSearchCacheState(cacheKey: string): "cold" | "warm" {
  return preparedSearchCacheState(cacheKey);
}

export function markSpotSearchPrepared(cacheKey: string): void {
  markPreparedSearchCache(cacheKey);
}

export type ActiveSpotSearchJob = {
  clientId: string;
  jobId: string;
};

function newId(): string {
  return crypto.randomUUID();
}

function clientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const created = newId();
  localStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

function saveActiveJob(job: ActiveSpotSearchJob): void {
  localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job));
}

export function readActiveSpotSearchJob(): ActiveSpotSearchJob | null {
  try {
    const value = JSON.parse(localStorage.getItem(ACTIVE_JOB_KEY) ?? "null") as unknown;
    return typeof value === "object" && value !== null &&
      "clientId" in value && typeof value.clientId === "string" &&
      "jobId" in value && typeof value.jobId === "string"
      ? { clientId: value.clientId, jobId: value.jobId }
      : null;
  } catch {
    return null;
  }
}

export function clearActiveSpotSearchJob(job: ActiveSpotSearchJob): void {
  const active = readActiveSpotSearchJob();
  if (active?.clientId === job.clientId && active.jobId === job.jobId) {
    localStorage.removeItem(ACTIVE_JOB_KEY);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    if (typeof data.error === "string") return data.error;
  } catch {
    // HTMLなどJSON以外のエラー応答ではHTTPステータスを表示する。
  }
  return `バックグラウンド検索APIエラー：${response.status}`;
}

export async function startBackgroundSpotSearch(
  input: SpotSearchJobInput,
  signal?: AbortSignal
): Promise<ActiveSpotSearchJob> {
  const active = { clientId: clientId(), jobId: newId() };
  saveActiveJob(active);
  const response = await fetch("/api/spot-search-start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...active, input }),
    signal,
  });
  if (!response.ok) {
    clearActiveSpotSearchJob(active);
    throw new Error(await errorMessage(response));
  }
  return active;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("検索結果の待機を中止しました", "AbortError")
    );
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("検索結果の待機を中止しました", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSpotSearchJob(value: unknown): value is SpotSearchJob {
  return typeof value === "object" && value !== null &&
    "status" in value && typeof value.status === "string" &&
    "progress" in value && typeof value.progress === "string" &&
    "results" in value && Array.isArray(value.results);
}

export async function waitForBackgroundSpotSearch(
  active: ActiveSpotSearchJob,
  signal: AbortSignal,
  onProgress: (message: string, percent: number) => void
): Promise<SpotSearchJob> {
  let missingRetryCount = 0;
  const waitStartedAt = Date.now();
  const missingJobTimeoutMilliseconds = 30_000;
  const queuedTimeoutMilliseconds = 45_000;
  // サーバー側の処理（外部API呼び出しの無応答等）で更新が完全に止まった場合、
  // running のまま無期限に待ち続けないようにする。
  const runningStallTimeoutMilliseconds = 90_000;
  let lastUpdatedAtMilliseconds = waitStartedAt;
  let lastObservedUpdatedAtIso: string | null = null;
  let lastReportedProgressPercent = 0;
  while (true) {
    if (signal.aborted) {
      throw new DOMException("検索結果の待機を中止しました", "AbortError");
    }
    const query = new URLSearchParams(active);
    const response = await fetch(`/api/spot-search-status?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (response.status === 404) {
      const isJsonResponse = (
        response.headers.get("content-type") ?? ""
      ).includes("application/json");
      // 開始API直後は別インスタンスの状態反映に時間差が出る場合がある。
      // JSONの「ジョブ未検出」だけを待ち、HTML 404（API未配置）は即時に区別する。
      const missingElapsedMilliseconds = Date.now() - waitStartedAt;
      if (
        isJsonResponse &&
        missingElapsedMilliseconds < missingJobTimeoutMilliseconds
      ) {
        missingRetryCount += 1;
        onProgress(
          `検索ジョブの起動を確認中（${Math.floor(
            missingElapsedMilliseconds / 1_000
          )}秒）`,
          0
        );
        await abortableDelay(1_000, signal);
        continue;
      }
      clearActiveSpotSearchJob(active);
      const detail = await errorMessage(response);
      throw new Error(isJsonResponse
        ? `${detail}。保存済みの古い検索状態を解除しました。もう一度検索してください`
        : `${detail}。この起動方法では検索APIが利用できません`);
    }
    if (!response.ok) throw new Error(await errorMessage(response));
    const job = await response.json() as unknown;
    if (!isSpotSearchJob(job)) {
      clearActiveSpotSearchJob(active);
      throw new Error("バックグラウンド検索の応答形式が不正です");
    }
    const jobUpdatedAtIso = typeof job.updatedAt === "string" ? job.updatedAt : null;
    const now = Date.now();
    if (jobUpdatedAtIso && jobUpdatedAtIso !== lastObservedUpdatedAtIso) {
      lastObservedUpdatedAtIso = jobUpdatedAtIso;
      lastUpdatedAtMilliseconds = now;
    } else if (!jobUpdatedAtIso) {
      // updatedAt が取得できない古い形式の応答では、経過時間の基準を待機開始時刻のままにする。
      lastUpdatedAtMilliseconds = Math.max(lastUpdatedAtMilliseconds, waitStartedAt);
    }
    if (
      job.status === "running" &&
      now - lastUpdatedAtMilliseconds >= runningStallTimeoutMilliseconds
    ) {
      clearActiveSpotSearchJob(active);
      throw new Error(
        "検索処理の進行が長時間止まりました。国土地理院や地図情報サービスの応答遅延が原因の可能性があります。時間帯の範囲を狭めるか、時間をおいてもう一度お試しください"
      );
    }
    const percent = typeof job.progressPercent === "number" ? job.progressPercent : 0;
    const boundedPercent = Math.max(
      lastReportedProgressPercent,
      Math.max(0, Math.min(100, Math.round(percent)))
    );
    lastReportedProgressPercent = boundedPercent;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - waitStartedAt) / 1000));
    const elapsedText = elapsedSeconds < 60
      ? `${elapsedSeconds}秒`
      : `${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒`;
    const stalledQueued = job.status === "queued" && elapsedSeconds >= 30;
    const heartbeat = boundedPercent === 0 &&
      (job.status === "queued" || job.status === "running")
      ? `${job.progress}\n${stalledQueued
          ? "検索処理の起動待ちが長引いています"
          : "サーバー応答確認済み"}・経過 ${elapsedText}`
      : job.progress;
    onProgress(heartbeat, boundedPercent);
    const jobCreatedAtMilliseconds = Date.parse(job.createdAt);
    const queuedElapsedMilliseconds = Number.isFinite(jobCreatedAtMilliseconds)
      ? Date.now() - jobCreatedAtMilliseconds
      : Date.now() - waitStartedAt;
    if (
      job.status === "queued" &&
      queuedElapsedMilliseconds >= queuedTimeoutMilliseconds
    ) {
      // 通信成功後のqueued停止なので、利用者の通信状態を原因として表示しない。
      // Active Jobは残し、Background Functionが遅れて開始した場合に再開できるようにする。
      throw new Error(
        "サーバー側の検索処理を起動できませんでした。検索画面を開き直して状態を再確認してください"
      );
    }
    if (job.status === "failed") {
      clearActiveSpotSearchJob(active);
      throw new Error(job.error ?? "バックグラウンド検索に失敗しました");
    }
    if (job.status === "awaiting-3d" || job.status === "complete") return job;
    await abortableDelay(1_500, signal);
  }
}

export function deserializeSpotSearchResults(
  results: SerializedSpotPresetResult[]
): SpotPresetResult[] {
  return results.map((result) => ({
    ...result,
    date: new Date(result.date),
    // 旧ジョブには状態が無いため、安全側の「未確認」として候補を維持する。
    candidate3dStatus: result.candidate3dStatus ?? "unverified",
  }));
}

export async function finalizeBackgroundSpotSearch(
  active: ActiveSpotSearchJob,
  results: SpotPresetResult[],
  signal?: AbortSignal
): Promise<void> {
  const serialized: SerializedSpotPresetResult[] = results.map((result) => ({
    ...result,
    date: result.date.toISOString(),
  }));
  const response = await fetch("/api/spot-search-finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...active, results: serialized }),
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  clearActiveSpotSearchJob(active);
}
