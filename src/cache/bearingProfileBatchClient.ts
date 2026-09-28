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
export async function fetchBearingProfileBatch(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<BearingProfileBatchResponseV1 | null> {
  if (signal?.aborted) throw createAbortError("全方位地形取得を中止しました");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(
    createTimeoutError("全方位地形APIがタイムアウトしました")
  ), BATCH_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError("全方位地形取得を中止しました"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetcher("/api/bearing-profile-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) return null;
    const value: unknown = await response.json();
    if (!validResponseEnvelope(value)) return null;
    return value.version === 2
      ? expandCompactResponse(request, value)
      : value;
  } catch (error) {
    if (signal?.aborted) throw createAbortError("全方位地形取得を中止しました");
    if (isAbortError(error) && controller.signal.reason?.name === "TimeoutError") return null;
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
