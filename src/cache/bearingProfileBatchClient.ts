import type {
  BearingProfileBatchFailure,
  BearingProfileBatchRequest,
  BearingProfileBatchResponse,
  BearingProfileBatchResponseV1,
  BearingProfileBatchResponseV2,
} from "../types/bearingProfileBatch";
import { calculateKarneyDestinationPoint } from "../geodesy/karneyGeodesic";
import { createAbortError, createTimeoutError, isAbortError } from "../utils/runtimeErrors";

const BATCH_REQUEST_TIMEOUT_MS = 45_000;
const MAX_BEARINGS_PER_REQUEST = 360;
const PRECOMPUTED_BEARING_PROFILE_FORMAT =
  "astrosight-precomputed-bearing-profile-v1";

export class PrecomputedBearingProfileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrecomputedBearingProfileUnavailableError";
  }
}

function validFailure(value: unknown): value is BearingProfileBatchFailure {
  if (typeof value !== "object" || value === null) return false;
  const failure = value as Record<string, unknown>;
  return typeof failure.bearingDegrees === "number" &&
    Number.isFinite(failure.bearingDegrees) &&
    failure.bearingDegrees >= 0 && failure.bearingDegrees < 360 &&
    typeof failure.reason === "string" && failure.reason.length > 0;
}

function validResponseEnvelope(value: unknown): value is BearingProfileBatchResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (response.version === 1 || response.version === 2) &&
    Array.isArray(response.profiles) &&
    Array.isArray(response.failedBearings) &&
    response.failedBearings.every(validFailure) &&
    Number.isSafeInteger(response.requestedBearingCount) &&
    Number(response.requestedBearingCount) > 0 &&
    Number(response.requestedBearingCount) <= MAX_BEARINGS_PER_REQUEST &&
    Number.isSafeInteger(response.pointCount) &&
    Number(response.pointCount) >= 0;
}

function selectPublishedProfileEnvelope(
  request: BearingProfileBatchRequest,
  value: unknown
): BearingProfileBatchResponseV2 | null {
  if (typeof value !== "object" || value === null) return null;
  const file = value as Record<string, unknown>;
  if (
    file.schemaVersion !== 1 ||
    file.format !== PRECOMPUTED_BEARING_PROFILE_FORMAT ||
    typeof file.subject !== "object" || file.subject === null ||
    typeof file.maxDistanceMeters !== "number" ||
    Math.abs(file.maxDistanceMeters - request.maxDistanceMeters) > 0.01 ||
    !validResponseEnvelope(file.response) ||
    file.response.version !== 2 ||
    file.response.failedBearings.length !== 0
  ) return null;
  const subject = file.subject as Record<string, unknown>;
  if (
    typeof subject.latitude !== "number" ||
    typeof subject.longitude !== "number" ||
    subject.latitude.toFixed(7) !== request.subjectPoint.latitude.toFixed(7) ||
    subject.longitude.toFixed(7) !== request.subjectPoint.longitude.toFixed(7)
  ) return null;
  const byBearing = new Map(
    file.response.profiles.flatMap((profile) =>
      typeof profile === "object" && profile !== null &&
      "bearingDegrees" in profile && typeof profile.bearingDegrees === "number"
        ? [[profile.bearingDegrees, profile] as const]
        : []
    )
  );
  const profiles = request.bearings.map((bearing) => byBearing.get(bearing));
  if (profiles.some((profile) => !profile)) return null;
  return {
    version: 2,
    precomputed: true,
    distancesMeters: file.response.distancesMeters,
    profiles: profiles as BearingProfileBatchResponseV2["profiles"],
    failedBearings: [],
    requestedBearingCount: request.bearings.length,
    pointCount: request.bearings.length * file.response.distancesMeters.length,
  };
}

const ELEVATION_SOURCES = new Set(["DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B", null]);

function expandCompactResponse(
  request: BearingProfileBatchRequest,
  response: BearingProfileBatchResponseV2
): BearingProfileBatchResponseV1 | null {
  if (!Array.isArray(response.distancesMeters) || response.distancesMeters.length === 0 ||
    response.distancesMeters.some((distance, index) =>
      !Number.isFinite(distance) || distance < 0 ||
      (index > 0 && distance <= response.distancesMeters[index - 1])
    ) ||
    response.requestedBearingCount !== request.bearings.length ||
    response.pointCount !== request.bearings.length * response.distancesMeters.length) return null;
  const requestedBearings = new Set(request.bearings);
  const resolvedBearings = new Set<number>();
  const profiles: BearingProfileBatchResponseV1["profiles"] = [];
  for (const value of response.profiles) {
    if (typeof value !== "object" || value === null ||
      !Number.isFinite(value.bearingDegrees) ||
      !requestedBearings.has(value.bearingDegrees) ||
      resolvedBearings.has(value.bearingDegrees) ||
      typeof value.computedAtIso !== "string" ||
      !Array.isArray(value.ellipsoidalHeightsMeters) ||
      !Array.isArray(value.elevationSources) ||
      value.ellipsoidalHeightsMeters.length !== response.distancesMeters.length ||
      value.elevationSources.length !== response.distancesMeters.length ||
      value.ellipsoidalHeightsMeters.some((height) => !Number.isFinite(height)) ||
      value.elevationSources.some((source) => !ELEVATION_SOURCES.has(source))) return null;
    resolvedBearings.add(value.bearingDegrees);
    profiles.push({
      bearingDegrees: value.bearingDegrees,
      computedAtIso: value.computedAtIso,
      points: response.distancesMeters.map((distanceMeters, index) => {
        const destination = calculateKarneyDestinationPoint(
          request.subjectPoint,
          value.bearingDegrees,
          distanceMeters
        );
        return {
          distanceMeters,
          latitude: destination.latitude,
          longitude: destination.longitude,
          ellipsoidalHeightMeters: value.ellipsoidalHeightsMeters[index],
          elevationSource: value.elevationSources[index],
        };
      }),
    });
  }
  for (const failure of response.failedBearings) {
    if (!requestedBearings.has(failure.bearingDegrees) ||
      resolvedBearings.has(failure.bearingDegrees)) return null;
    resolvedBearings.add(failure.bearingDegrees);
  }
  if (resolvedBearings.size !== requestedBearings.size) return null;
  return {
    version: 1,
    precomputed: response.precomputed === true,
    profiles,
    failedBearings: response.failedBearings,
    requestedBearingCount: response.requestedBearingCount,
    pointCount: response.pointCount,
  };
}

/**
 * Returns null when the new endpoint is absent or temporarily unavailable so a
 * previously deployed Pages build can continue through the established direct
 * per-bearing path. User cancellation remains an abort and is never converted
 * to fallback work.
 */
/**
 * 計算済みデータを使えなかった理由。以前はすべて null に畳み込まれ、
 * 画面には何も出ないまま1方位ずつの直接取得（約1時間）へ落ちていた。
 */
export type BearingProfileBatchMiss = {
  /** true: この地点に計算済みデータが無いだけ（任意座標の正常系）。 */
  notPrecomputed: boolean;
  reason: string;
};

export type BearingProfileBatchOutcome =
  | { ok: true; response: BearingProfileBatchResponseV1 }
  | { ok: false; miss: BearingProfileBatchMiss };

async function responseErrorText(response: Response): Promise<{ code: string | null; error: string | null }> {
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) return { code: null, error: null };
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null) return { code: null, error: null };
    const record = value as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : null,
      error: typeof record.error === "string" ? record.error : null,
    };
  } catch {
    return { code: null, error: null };
  }
}

export async function fetchBearingProfileBatchDetailed(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<BearingProfileBatchOutcome> {
  if (signal?.aborted) throw createAbortError("全方位地形取得を中止しました");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(
    createTimeoutError("全方位地形APIがタイムアウトしました")
  ), BATCH_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError("全方位地形取得を中止しました"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const miss = (reason: string, notPrecomputed = false): BearingProfileBatchOutcome =>
    ({ ok: false, miss: { notPrecomputed, reason } });
  try {
    const response = await fetcher("/api/bearing-profile-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { code, error } = await responseErrorText(response);
      if (response.status === 503 && code === "PRECOMPUTED_PROFILE_UNAVAILABLE" && error) {
        throw new PrecomputedBearingProfileUnavailableError(error);
      }
      if (response.status === 404 && code === "PRECOMPUTED_PROFILE_NOT_FOUND") {
        return miss(
          Math.round(request.maxDistanceMeters) === 10_000
            ? "この地点には計算済み地形データがありません"
            : `計算済み地形データは探索範囲10kmのみです（現在${(request.maxDistanceMeters / 1000).toFixed(0)}km）`,
          true
        );
      }
      return miss(`全方位地形APIがHTTP ${response.status}を返しました${error ? `（${error}）` : ""}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return miss(`全方位地形APIの応答形式が不正です（${contentType || "Content-Typeなし"}）`);
    }
    const value: unknown = await response.json();
    const normalized = validResponseEnvelope(value)
      ? value
      : selectPublishedProfileEnvelope(request, value);
    if (!normalized) return miss("全方位地形APIの応答内容を検証できませんでした");
    const expanded = normalized.version === 2
      ? expandCompactResponse(request, normalized)
      : normalized;
    if (!expanded) return miss("計算済み地形データの展開・検証に失敗しました");
    return { ok: true, response: expanded };
  } catch (error) {
    if (signal?.aborted) throw createAbortError("全方位地形取得を中止しました");
    if (error instanceof PrecomputedBearingProfileUnavailableError) throw error;
    if (isAbortError(error) && controller.signal.reason?.name === "TimeoutError") {
      return miss(`全方位地形APIが${Math.round(BATCH_REQUEST_TIMEOUT_MS / 1000)}秒以内に応答しませんでした`);
    }
    return miss(`全方位地形APIへ接続できませんでした（${error instanceof Error ? error.message : String(error)}）`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchBearingProfileBatch(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<BearingProfileBatchResponseV1 | null> {
  const outcome = await fetchBearingProfileBatchDetailed(request, signal, fetcher);
  return outcome.ok ? outcome.response : null;
}
