import type {
  SerializedSpotPresetResult,
  SpotSearchJob,
  SpotSearchJobInput,
} from "../types/backgroundSearch";
import type { SpotPresetResult } from "../types/search";

const CLIENT_ID_KEY = "ksg-spot-search-client-id-v1";
const ACTIVE_JOB_KEY = "ksg-active-spot-search-v1";

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
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("検索結果の待機を中止しました", "AbortError"));
    }, { once: true });
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
  onProgress: (message: string) => void
): Promise<SpotSearchJob> {
  let missingRetryCount = 0;
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
    if (response.status === 404 && missingRetryCount < 4) {
      missingRetryCount += 1;
      await abortableDelay(500, signal);
      continue;
    }
    if (!response.ok) throw new Error(await errorMessage(response));
    const job = await response.json() as unknown;
    if (!isSpotSearchJob(job)) {
      throw new Error("バックグラウンド検索の応答形式が不正です");
    }
    onProgress(job.progress);
    if (job.status === "failed") {
      throw new Error(job.error ?? "バックグラウンド検索に失敗しました");
    }
    if (job.status === "awaiting-3d" || job.status === "complete") return job;
    await abortableDelay(1_500, signal);
  }
}

export function deserializeSpotSearchResults(
  results: SerializedSpotPresetResult[]
): SpotPresetResult[] {
  return results.map((result) => ({ ...result, date: new Date(result.date) }));
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
