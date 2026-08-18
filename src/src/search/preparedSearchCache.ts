const STORAGE_KEY = "ksg-spot-search-prepared-cache-v3";
const PREVIOUS_STORAGE_KEY = "ksg-spot-search-prepared-cache-v2";
const LEGACY_STORAGE_KEY = "ksg-spot-search-prepared-cache-v1";
const MAX_ENTRIES = 120;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type PreparedSearchCacheRecord = {
  key: string;
  updatedAt: number;
  hits: number;
};

function isRecord(value: unknown): value is PreparedSearchCacheRecord {
  return typeof value === "object" && value !== null &&
    "key" in value && typeof value.key === "string" &&
    "updatedAt" in value && typeof value.updatedAt === "number" &&
    "hits" in value && typeof value.hits === "number";
}

function loadRaw(): unknown[] {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(current)) return current;
    // v2以前のキーは条件不足のためwarm判定へ移行しない。
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(legacy) ? legacy : [];
  } catch {
    return [];
  }
}

function normalize(value: unknown): PreparedSearchCacheRecord | null {
  if (isRecord(value)) return value;
  if (
    typeof value === "object" && value !== null &&
    "key" in value && typeof value.key === "string" &&
    "updatedAt" in value && typeof value.updatedAt === "number"
  ) {
    return { key: value.key, updatedAt: value.updatedAt, hits: 0 };
  }
  return null;
}

export function readPreparedSearchCache(): PreparedSearchCacheRecord[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  const records = loadRaw()
    .map(normalize)
    .filter((entry): entry is PreparedSearchCacheRecord => entry !== null && entry.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES);
  persistPreparedSearchCache(records);
  return records;
}

function persistPreparedSearchCache(records: PreparedSearchCacheRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    localStorage.removeItem(PREVIOUS_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 容量不足やプライベートモードでは、検索自体を止めずキャッシュだけ無効化する。
  }
}

export function preparedSearchCacheState(key: string): "cold" | "warm" {
  const records = readPreparedSearchCache();
  const index = records.findIndex((entry) => entry.key === key);
  if (index < 0) return "cold";
  const [entry] = records.splice(index, 1);
  entry.hits += 1;
  entry.updatedAt = Date.now();
  persistPreparedSearchCache([entry, ...records].slice(0, MAX_ENTRIES));
  return "warm";
}

export function markPreparedSearchCache(key: string): void {
  const records = readPreparedSearchCache();
  const existing = records.find((entry) => entry.key === key);
  const next: PreparedSearchCacheRecord = {
    key,
    updatedAt: Date.now(),
    hits: existing?.hits ?? 0,
  };
  persistPreparedSearchCache([
    next,
    ...records.filter((entry) => entry.key !== key),
  ].slice(0, MAX_ENTRIES));
}
