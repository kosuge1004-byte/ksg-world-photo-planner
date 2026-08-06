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

export async function diagnosticFetch(
  category: string,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const startedAt = performance.now();
  try {
    const response = await fetch(input, init);
    recordNetworkDiagnostic({
      kind: "request",
      category,
      endpoint,
      method,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return response;
  } catch (error) {
    recordNetworkDiagnostic({
      kind: "error",
      category,
      endpoint,
      method,
      durationMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
