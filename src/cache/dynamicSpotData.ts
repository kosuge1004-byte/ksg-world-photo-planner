import { apiEndpoint } from "../network/apiEndpoint";
import {
  DYNAMIC_SPOT_BEARING_COUNT,
  DYNAMIC_SPOT_MAX_DISTANCE_METERS,
  DYNAMIC_SPOT_PROFILE_VERSION,
  DYNAMIC_SPOT_SCHEMA_VERSION,
  dynamicSpotCoordinateKey,
  isDynamicSpotRecord,
  normalizeDynamicSpotSearchText,
  type DynamicSpotRecord,
  type DynamicSpotRegistrationInput,
} from "../types/dynamicSpot";

const STORAGE_KEY = "astrosight-dynamic-spots-v1";
const LOOKUP_TIMEOUT_MS = 2_500;
const WRITE_TIMEOUT_MS = 8_000;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch { return null; }
}

export function listLocalDynamicSpots(): DynamicSpotRecord[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter(isDynamicSpotRecord) : [];
  } catch { return []; }
}

export function upsertLocalDynamicSpot(record: DynamicSpotRecord): DynamicSpotRecord[] {
  if (!isDynamicSpotRecord(record)) return listLocalDynamicSpots();
  const next = [record, ...listLocalDynamicSpots().filter((item) => item.coordinateKey !== record.coordinateKey)]
    .slice(0, 200);
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* search remains usable */ }
  return next;
}

export function findLocalDynamicSpotByQuery(query: string): DynamicSpotRecord | null {
  const normalized = normalizeDynamicSpotSearchText(query);
  if (!normalized) return null;
  const matches = listLocalDynamicSpots().filter((spot) =>
    [spot.name, ...spot.aliases].some((name) => normalizeDynamicSpotSearchText(name) === normalized)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function findLocalDynamicSpotByCoordinate(
  latitude: number,
  longitude: number
): DynamicSpotRecord | null {
  let key: string;
  try { key = dynamicSpotCoordinateKey(latitude, longitude); } catch { return null; }
  return listLocalDynamicSpots().find((spot) => spot.coordinateKey === key) ?? null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createPendingLocalDynamicSpot(
  input: DynamicSpotRegistrationInput
): Promise<DynamicSpotRecord> {
  const coordinateKey = dynamicSpotCoordinateKey(input.latitude, input.longitude);
  const existing = findLocalDynamicSpotByCoordinate(input.latitude, input.longitude);
  const now = new Date().toISOString();
  const sameCompletedSubject = existing?.demProfileStatus === "complete" &&
    existing.subjectSurface === input.subjectSurface &&
    (input.subjectSurface === "terrain" ||
      (input.structureHeightMeters !== null &&
        existing.structureHeightMeters === input.structureHeightMeters &&
        input.heightSourceType !== "unknown" && input.heightStatus !== "unknown"));
  return {
    schemaVersion: DYNAMIC_SPOT_SCHEMA_VERSION,
    id: existing?.id ?? `dynamic-${(await sha256Hex(coordinateKey)).slice(0, 32)}`,
    name: input.name,
    aliases: Array.from(new Set([...(existing?.aliases ?? []), input.name, ...input.aliases])).slice(0, 20),
    latitude: input.latitude,
    longitude: input.longitude,
    category: input.category,
    subjectSurface: input.subjectSurface,
    structureHeightMeters: input.structureHeightMeters,
    heightSourceType: input.heightSourceType,
    heightSourceUrl: input.heightSourceUrl,
    heightSourceLabel: input.heightSourceLabel,
    heightStatus: input.heightStatus,
    demProfileStatus: sameCompletedSubject ? "complete" : "pending",
    maxDistanceMeters: DYNAMIC_SPOT_MAX_DISTANCE_METERS,
    bearingCount: DYNAMIC_SPOT_BEARING_COUNT,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    coordinateKey,
    profileVersion: DYNAMIC_SPOT_PROFILE_VERSION,
    completedBearings: sameCompletedSubject ? existing?.completedBearings ?? 0 : 0,
    failedBearings: sameCompletedSubject ? existing?.failedBearings ?? 0 : 0,
    currentStage: sameCompletedSubject ? existing?.currentStage ?? "complete" : "waiting",
    generationStartedAt: sameCompletedSubject ? existing?.generationStartedAt ?? null : null,
    generationElapsedMs: sameCompletedSubject ? existing?.generationElapsedMs ?? 0 : 0,
    lastError: null,
    profileBytes: sameCompletedSubject ? existing?.profileBytes : undefined,
    profileSha256: sameCompletedSubject ? existing?.profileSha256 ?? null : null,
  };
}

async function requestSpot(
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  if (signal?.aborted) throw new DOMException("Dynamic Spot処理を中止しました", "AbortError");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(apiEndpoint(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json() as { spot?: unknown };
    if (!isDynamicSpotRecord(value.spot)) return null;
    upsertLocalDynamicSpot(value.spot);
    return value.spot;
  } catch {
    if (signal?.aborted) throw new DOMException("Dynamic Spot処理を中止しました", "AbortError");
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function lookupEdriveDynamicSpotByQuery(
  query: string,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestSpot("/api/dynamic-spot-lookup", { query }, LOOKUP_TIMEOUT_MS, signal);
}

export function registerEdriveDynamicSpot(
  input: DynamicSpotRegistrationInput,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return registerEdriveDynamicSpotDetailed(input, signal).then((outcome) => outcome.spot);
}

export type DynamicSpotRegistrationOutcome = {
  spot: DynamicSpotRecord | null;
  queued: boolean;
  code: string | null;
};

/**
 * 503でもD1への登録待ちキュー投入が成功している場合がある。従来はresponse.okだけを
 * 見て本文を捨てていたため、端末が監視を終了して0/360のままに見えていた。
 */
export async function registerEdriveDynamicSpotDetailed(
  input: DynamicSpotRegistrationInput,
  signal?: AbortSignal
): Promise<DynamicSpotRegistrationOutcome> {
  if (signal?.aborted) throw new DOMException("Dynamic Spot処理を中止しました", "AbortError");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(apiEndpoint("/api/dynamic-spot-register"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const value = contentType.includes("application/json")
      ? await response.json() as Record<string, unknown>
      : {};
    if (isDynamicSpotRecord(value.spot)) {
      upsertLocalDynamicSpot(value.spot);
      return { spot: value.spot, queued: false, code: null };
    }
    return {
      spot: null,
      queued: value.queued === true,
      code: typeof value.code === "string" ? value.code : null,
    };
  } catch {
    if (signal?.aborted) throw new DOMException("Dynamic Spot処理を中止しました", "AbortError");
    return { spot: null, queued: false, code: null };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function readEdriveDynamicSpotStatus(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestSpot("/api/dynamic-spot-status", { latitude, longitude }, LOOKUP_TIMEOUT_MS, signal);
}
