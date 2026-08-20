export type NetworkDiagnosticKind = "request" | "cache-hit" | "cache-miss" | "deduplicated" | "error";

export type NetworkDiagnosticEvent = {
  time: number;
  kind: NetworkDiagnosticKind;
  category: string;
  endpoint: string;
  method?: string;
  status?: number;
  durationMs?: number;
  detail?: string;
};

export type NetworkDiagnosticSummary = {
  requestCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  deduplicatedCount: number;
  errorCount: number;
  byCategory: Record<string, number>;
  recent: NetworkDiagnosticEvent[];
};

const STORAGE_KEY = "astrosight-network-diagnostics-v1";
const MAX_RECENT_EVENTS = 200;

function emptySummary(): NetworkDiagnosticSummary {
  return {
    requestCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    deduplicatedCount: 0,
    errorCount: 0,
    byCategory: {},
    recent: [],
  };
}

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type DiagnosticsGlobal = typeof globalThis & {
  localStorage?: StorageLike;
};

function getLocalStorage(): StorageLike | null {
  const candidate = globalThis as DiagnosticsGlobal;
  return typeof candidate.localStorage === "undefined" ? null : candidate.localStorage;
}

export function readNetworkDiagnosticSummary(): NetworkDiagnosticSummary {
  const storage = getLocalStorage();
  if (!storage) return emptySummary();
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<NetworkDiagnosticSummary> | null;
    if (!parsed) return emptySummary();
    return {
      requestCount: Number(parsed.requestCount) || 0,
      cacheHitCount: Number(parsed.cacheHitCount) || 0,
      cacheMissCount: Number(parsed.cacheMissCount) || 0,
      deduplicatedCount: Number(parsed.deduplicatedCount) || 0,
      errorCount: Number(parsed.errorCount) || 0,
      byCategory: parsed.byCategory && typeof parsed.byCategory === "object" ? parsed.byCategory : {},
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(-MAX_RECENT_EVENTS) as NetworkDiagnosticEvent[] : [],
    };
  } catch {
    return emptySummary();
  }
}

function persist(summary: NetworkDiagnosticSummary): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(summary));
  } catch {
    // Diagnostics must never interfere with application behavior.
  }
}

export function recordNetworkDiagnostic(event: Omit<NetworkDiagnosticEvent, "time">): void {
  const summary = readNetworkDiagnosticSummary();
  const fullEvent: NetworkDiagnosticEvent = { ...event, time: Date.now() };
  if (event.kind === "request") summary.requestCount += 1;
  if (event.kind === "cache-hit") summary.cacheHitCount += 1;
  if (event.kind === "cache-miss") summary.cacheMissCount += 1;
  if (event.kind === "deduplicated") summary.deduplicatedCount += 1;
  if (event.kind === "error") summary.errorCount += 1;
  summary.byCategory[event.category] = (summary.byCategory[event.category] ?? 0) + 1;
  summary.recent = [...summary.recent, fullEvent].slice(-MAX_RECENT_EVENTS);
  persist(summary);
}

export function recordCacheDiagnostic(
  category: string,
  endpoint: string,
  kind: "cache-hit" | "cache-miss" | "deduplicated",
  detail?: string
): void {
  recordNetworkDiagnostic({ category, endpoint, kind, detail });
}

// サーバー・外部APIが応答をハングさせた場合、ユーザー操作によるabort
// （init.signal）以外に、これまで自動的に諦める仕組みが一切なかった。
// 「数分待っても描画されない」という不具合の主因になっていたため、
// 全通信の共通入口であるここに自動タイムアウト＋リトライを組み込む。
// 個別のfetch呼び出しごとに直す必要が無いよう、一箇所へ集約する。
//
// タイムアウトを長くして1回だけ待つより、短めのタイムアウトで複数回
// 試したほうが「一時的な通信の乱れ」からの回復率が高く、かつ最悪時の
// 合計待ち時間も抑えられる（8秒×最大3回＋短い間隔 ≒ 最悪でも30秒弱）。
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [300, 900];

function combinedSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal | null
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;
}

function isUserAbort(error: unknown, externalSignal?: AbortSignal | null): boolean {
  return Boolean(externalSignal?.aborted) && error instanceof DOMException && error.name === "AbortError";
}

/** タイムアウト・ネットワーク断（fetch自体が例外を投げた場合）は常に
 * 再試行対象にする。応答が返っているサーバーエラー（5xx）は呼び出し側で
 * 別途判定する（400/404等のクライアントエラーは再試行しても結果が
 * 変わらないため、そもそもここへは来ない設計にしている）。 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function diagnosticFetch(
  category: string,
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = performance.now();
    try {
      const response = await fetch(input, {
        ...init,
        signal: combinedSignal(timeoutMs, init?.signal),
      });
      recordNetworkDiagnostic({
        kind: "request",
        category,
        endpoint,
        method,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        detail: attempt > 1 ? `${attempt}回目の試行で成功` : undefined,
      });
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        await wait(RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      recordNetworkDiagnostic({
        kind: "error",
        category,
        endpoint,
        method,
        durationMs: Math.round(performance.now() - startedAt),
        detail: error instanceof Error ? error.message : String(error),
      });
      // ユーザー自身によるキャンセル（検索中止等）は再試行しない。
      if (isUserAbort(error, init?.signal)) throw error;
      if (attempt < MAX_ATTEMPTS) {
        await wait(RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export function resetNetworkDiagnosticSummary(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
