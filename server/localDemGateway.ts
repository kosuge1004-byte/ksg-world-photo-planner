import {
  serverLocalDemGateway,
  type LocalDemGatewayConfiguration,
} from "./cloudflareRuntime.ts";
import { createAbortError, createTimeoutError } from "./runtimeErrors.ts";
import type {
  BearingProfileBatchRequest,
  BearingProfileBatchResponseV2,
} from "../src/types/bearingProfileBatch.ts";
import { isPrecomputedBearingProfileResponse } from "./precomputedBearingProfiles.ts";
import {
  isDynamicSpotRecord,
  type DynamicSpotRecord,
  type DynamicSpotRegistrationInput,
} from "../src/types/dynamicSpot.ts";
import {
  isQuickTunnelElevationEndpoint,
  readRegisteredLocalDemEndpoint,
} from "./localDemEndpointRegistry.ts";

export type LocalDemGatewaySource =
  | "DEM1A"
  | "DEM5A"
  | "DEM5B"
  | "DEM5C"
  | "DEM10B";

export type LocalDemGatewayPoint = {
  index: number;
  latitude: number;
  longitude: number;
  interpolation: "bilinear" | "constrained-bicubic";
  interpolationMode: "los-safe" | "neutral";
};

export type LocalDemGatewayAutoPoint = {
  index: number;
  latitude: number;
  longitude: number;
  maximumDetail: "1m" | "5m" | "10m";
  interpolationMode: "los-safe" | "neutral";
};

export type LocalDemGatewaySample = {
  heightMeters: number | null;
  source: LocalDemGatewaySource | null;
};

const MAX_POINTS_PER_REQUEST = 512;
// The origin normally reads prepared E-drive assets in milliseconds. A first
// request may also need to fill a missing precision tier from GSI, so two
// seconds was too short and unnecessarily returned work to the constrained
// Cloudflare path. The timeout remains finite and abortable.
const REQUEST_TIMEOUT_MS = 12_000;
// The PC origin performs the complete exact-coordinate calculation in one
// request. Its own deadline is 30 seconds; allow a small transport margin while
// still guaranteeing that the browser never waits for the former hour-long
// device fallback.
const COMPUTED_PROFILE_REQUEST_TIMEOUT_MS = 35_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
// A 259-bearing, 10 km compact profile is about 2.4 MiB and a complete
// 360-bearing catalogue profile is about 3.3 MiB. Keep a firm ceiling above
// both valid responses while still rejecting an unexpectedly large origin
// body before JSON parsing.
// 富士山100km・360方位の非圧縮compact JSONも受け取れる上限。通常地点は
// 従来どおり数MiB以内で、これは任意ファイルではなく検証済みJSONだけに適用。
const MAX_PROFILE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MIN_HEIGHT_METERS = -500;
const MAX_HEIGHT_METERS = 10_000;

let blockedEndpoint: string | null = null;
let blockedUntil = 0;
let blockedProfileEndpoint: string | null = null;
let blockedProfileUntil = 0;
let blockedComputedProfileEndpoint: string | null = null;
let blockedComputedProfileUntil = 0;

type ResolvedLocalDemGatewayConfiguration = LocalDemGatewayConfiguration & {
  endpoint: string;
  originToken: string;
};

async function resolvedGatewayConfiguration(): Promise<ResolvedLocalDemGatewayConfiguration | null> {
  const configuration = serverLocalDemGateway();
  if (!configuration?.originToken) return null;
  if (!configuration.endpoint && configuration.endpointRegistry) {
    configuration.endpoint = await readRegisteredLocalDemEndpoint(
      configuration.endpointRegistry
    ) ?? undefined;
  }
  if (!configuration.endpoint) return null;
  return configuration as ResolvedLocalDemGatewayConfiguration;
}

function gatewayHeaders(
  configuration: ResolvedLocalDemGatewayConfiguration
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    "X-AstroSight-Origin-Token": configuration.originToken,
  };
  if (configuration.accessClientId && configuration.accessClientSecret) {
    headers["CF-Access-Client-Id"] = configuration.accessClientId;
    headers["CF-Access-Client-Secret"] = configuration.accessClientSecret;
  }
  return headers;
}

function endpointUrl(configuration: LocalDemGatewayConfiguration): URL | null {
  try {
    const url = new URL(configuration.endpoint ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/v1/elevation/batch"
    ) {
      return null;
    }
    if (!configuration.accessClientId && !configuration.accessClientSecret &&
      !isQuickTunnelElevationEndpoint(url.toString())) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function precomputedProfileEndpointUrl(configuration: LocalDemGatewayConfiguration): URL | null {
  const elevationEndpoint = endpointUrl(configuration);
  if (!elevationEndpoint) return null;
  return new URL("/v1/bearing-profile/precomputed", elevationEndpoint);
}

function computedProfileEndpointUrl(configuration: LocalDemGatewayConfiguration): URL | null {
  const elevationEndpoint = endpointUrl(configuration);
  if (!elevationEndpoint) return null;
  return new URL("/v1/bearing-profile/compute", elevationEndpoint);
}

function dynamicSpotEndpointUrl(
  configuration: LocalDemGatewayConfiguration,
  action: "lookup" | "register" | "status" | "retry"
): URL | null {
  const elevationEndpoint = endpointUrl(configuration);
  if (!elevationEndpoint) return null;
  return new URL(`/v1/dynamic-spot/${action}`, elevationEndpoint);
}

async function requestDynamicSpot(
  action: "lookup" | "register" | "status" | "retry",
  body: unknown,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  const configuration = await resolvedGatewayConfiguration();
  if (!configuration) return null;
  const endpoint = dynamicSpotEndpointUrl(configuration, action);
  if (!endpoint) return null;
  if (signal?.aborted) throw createAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError("Dynamic Spot APIタイムアウト"));
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: gatewayHeaders(configuration),
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const value = await readBoundedJson(response);
    if (typeof value !== "object" || value === null || !("spot" in value) ||
      !isDynamicSpotRecord(value.spot)) return null;
    return value.spot;
  } catch {
    if (signal?.aborted && !timedOut) throw createAbortError();
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function lookupLocalDynamicSpot(
  lookup: { query: string } | { latitude: number; longitude: number },
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestDynamicSpot("lookup", lookup, signal);
}

export function registerLocalDynamicSpot(
  input: DynamicSpotRegistrationInput,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestDynamicSpot("register", input, signal);
}

export function readLocalDynamicSpotStatus(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestDynamicSpot("status", { latitude, longitude }, signal);
}

export function retryLocalDynamicSpot(
  latitude: number,
  longitude: number,
  signal?: AbortSignal
): Promise<DynamicSpotRecord | null> {
  return requestDynamicSpot("retry", { latitude, longitude }, signal);
}

function isJapanPoint(point: { latitude: number; longitude: number }): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    point.latitude >= 20 && point.latitude <= 46.5 &&
    point.longitude >= 122 && point.longitude <= 154;
}

async function readBoundedJson(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("ローカルDEM APIの応答が大きすぎます");
  }
  if (!response.body) throw new Error("ローカルDEM APIの応答本文がありません");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("ローカルDEM APIの応答が大きすぎます");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/**
 * Return a compact, already calculated profile from the private E-drive
 * origin. A miss or origin failure is deliberately null: the caller then runs
 * the established calculation path with identical precision.
 */
export async function lookupLocalPrecomputedBearingProfile(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal
): Promise<BearingProfileBatchResponseV2 | null> {
  const configuration = await resolvedGatewayConfiguration();
  if (!configuration) return null;
  const endpoint = precomputedProfileEndpointUrl(configuration);
  if (!endpoint) return null;
  const endpointKey = endpoint.toString();
  if (blockedProfileEndpoint === endpointKey && blockedProfileUntil > Date.now()) return null;
  if (signal?.aborted) throw createAbortError();

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError("計算済み地形APIタイムアウト"));
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: gatewayHeaders(configuration),
      body: JSON.stringify({
        subjectPoint: {
          latitude: request.subjectPoint.latitude,
          longitude: request.subjectPoint.longitude,
          height: 0,
        },
        cameraSettings: { lensCenterHeightMeters: 0 },
        bearings: request.bearings,
        maxDistanceMeters: request.maxDistanceMeters,
      }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`計算済み地形APIがHTTP ${response.status}を返しました`);
    }
    const body = await readBoundedJson(response, MAX_PROFILE_RESPONSE_BYTES);
    if (!isPrecomputedBearingProfileResponse(body, request)) {
      throw new Error("計算済み地形APIの応答形式が不正です");
    }
    blockedProfileEndpoint = null;
    blockedProfileUntil = 0;
    return body;
  } catch {
    if (signal?.aborted && !timedOut) throw createAbortError();
    blockedProfileEndpoint = endpointKey;
    blockedProfileUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Last-resort exact profile calculation at the private E-drive origin. The
 * origin evaluates every requested coordinate from the prepared GSI data; it
 * never shifts or reuses a neighbouring profile. Any timeout, authentication
 * failure, malformed response or partial result is returned as null so the
 * Pages endpoint can fail quickly instead of starting the ~54 minute device
 * path.
 */
export async function computeLocalBearingProfile(
  request: BearingProfileBatchRequest,
  signal?: AbortSignal
): Promise<BearingProfileBatchResponseV2 | null> {
  const configuration = await resolvedGatewayConfiguration();
  if (!configuration) return null;
  const endpoint = computedProfileEndpointUrl(configuration);
  if (!endpoint) return null;
  const endpointKey = endpoint.toString();
  if (blockedComputedProfileEndpoint === endpointKey &&
    blockedComputedProfileUntil > Date.now()) return null;
  if (signal?.aborted) throw createAbortError();

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError("Eドライブ全方位計算タイムアウト"));
  }, COMPUTED_PROFILE_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: gatewayHeaders(configuration),
      body: JSON.stringify({
        subjectPoint: {
          latitude: request.subjectPoint.latitude,
          longitude: request.subjectPoint.longitude,
          height: request.subjectPoint.height,
        },
        cameraSettings: {
          lensCenterHeightMeters: request.cameraSettings.lensCenterHeightMeters,
        },
        bearings: request.bearings,
        maxDistanceMeters: request.maxDistanceMeters,
      }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Eドライブ全方位APIがHTTP ${response.status}を返しました`);
    }
    const body = await readBoundedJson(response, MAX_PROFILE_RESPONSE_BYTES);
    if (!isPrecomputedBearingProfileResponse(body, request) ||
      body.terrainProfileComplete !== true) {
      throw new Error("Eドライブ全方位APIの応答形式が不正です");
    }
    blockedComputedProfileEndpoint = null;
    blockedComputedProfileUntil = 0;
    return body;
  } catch {
    if (signal?.aborted && !timedOut) throw createAbortError();
    blockedComputedProfileEndpoint = endpointKey;
    blockedComputedProfileUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function validatedResults(
  body: unknown,
  source: LocalDemGatewaySource,
  points: readonly LocalDemGatewayPoint[]
): Map<number, number> {
  if (
    typeof body !== "object" || body === null ||
    !("source" in body) || body.source !== source ||
    !("results" in body) || !Array.isArray(body.results) ||
    body.results.length !== points.length
  ) {
    throw new Error("ローカルDEM APIの応答形式が不正です");
  }

  const expected = new Set(points.map((point) => point.index));
  const seen = new Set<number>();
  const resolved = new Map<number, number>();
  for (const result of body.results) {
    if (
      typeof result !== "object" || result === null ||
      !("index" in result) || !Number.isInteger(result.index) ||
      !expected.has(result.index) || seen.has(result.index) ||
      !("heightMeters" in result)
    ) {
      throw new Error("ローカルDEM APIの地点応答が不正です");
    }
    seen.add(result.index);
    if (result.heightMeters === null) continue;
    if (
      typeof result.heightMeters !== "number" ||
      !Number.isFinite(result.heightMeters) ||
      result.heightMeters < MIN_HEIGHT_METERS ||
      result.heightMeters > MAX_HEIGHT_METERS
    ) {
      throw new Error("ローカルDEM APIの標高値が不正です");
    }
    resolved.set(result.index, result.heightMeters);
  }
  if (seen.size !== expected.size) {
    throw new Error("ローカルDEM APIの地点数が一致しません");
  }
  return resolved;
}

function validatedAutoResults(
  body: unknown,
  points: readonly LocalDemGatewayAutoPoint[]
): Map<number, LocalDemGatewaySample> {
  if (
    typeof body !== "object" || body === null ||
    !("mode" in body) || body.mode !== "auto" ||
    !("complete" in body) || body.complete !== true ||
    !("results" in body) || !Array.isArray(body.results) ||
    body.results.length !== points.length
  ) {
    throw new Error("ローカルDEM APIの自動応答形式が不正です");
  }
  const expected = new Set(points.map((point) => point.index));
  const seen = new Set<number>();
  const resolved = new Map<number, LocalDemGatewaySample>();
  for (const result of body.results) {
    if (
      typeof result !== "object" || result === null ||
      !("index" in result) || !Number.isInteger(result.index) ||
      !expected.has(result.index as number) || seen.has(result.index as number) ||
      !("heightMeters" in result) || !("source" in result)
    ) {
      throw new Error("ローカルDEM APIの自動地点応答が不正です");
    }
    const source = result.source;
    const heightMeters = result.heightMeters;
    if (source === null && heightMeters === null) {
      // Authoritative NoData/water. Keeping this distinct from an unavailable
      // gateway lets the caller continue with H=0 without public tile fan-out.
      resolved.set(result.index as number, { heightMeters: null, source: null });
    } else if (
      typeof source === "string" &&
      (source === "DEM1A" || source === "DEM5A" || source === "DEM5B" ||
        source === "DEM5C" || source === "DEM10B") &&
      typeof heightMeters === "number" && Number.isFinite(heightMeters) &&
      heightMeters >= MIN_HEIGHT_METERS && heightMeters <= MAX_HEIGHT_METERS
    ) {
      resolved.set(result.index as number, {
        heightMeters,
        source: source as LocalDemGatewaySource,
      });
    } else {
      throw new Error("ローカルDEM APIの自動標高値が不正です");
    }
    seen.add(result.index as number);
  }
  if (seen.size !== expected.size) {
    throw new Error("ローカルDEM APIの自動地点数が一致しません");
  }
  return resolved;
}

async function requestChunk(
  configuration: ResolvedLocalDemGatewayConfiguration,
  endpoint: URL,
  source: LocalDemGatewaySource,
  points: readonly LocalDemGatewayPoint[],
  signal?: AbortSignal
): Promise<Map<number, number>> {
  if (signal?.aborted) throw createAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError("ローカルDEM APIタイムアウト"));
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: gatewayHeaders(configuration),
      body: JSON.stringify({ source, points }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ローカルDEM APIがHTTP ${response.status}を返しました`);
    }
    return validatedResults(await readBoundedJson(response), source, points);
  } catch (error) {
    if (signal?.aborted && !timedOut) throw createAbortError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function requestAutoChunk(
  configuration: ResolvedLocalDemGatewayConfiguration,
  endpoint: URL,
  points: readonly LocalDemGatewayAutoPoint[],
  signal?: AbortSignal
): Promise<Map<number, LocalDemGatewaySample>> {
  if (signal?.aborted) throw createAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError("ローカルDEM APIタイムアウト"));
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(createAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: gatewayHeaders(configuration),
      body: JSON.stringify({ mode: "auto", points }),
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ローカルDEM APIがHTTP ${response.status}を返しました`);
    }
    return validatedAutoResults(await readBoundedJson(response), points);
  } catch (error) {
    if (signal?.aborted && !timedOut) throw createAbortError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Resolve the complete GSI source-priority decision at the E-drive origin.
 * A non-null result is authoritative and aligned to the supplied indexes. Any
 * network, authentication, timeout or validation failure returns null so the
 * established per-source/public-GSI path remains available.
 */
export async function lookupLocalDemGatewayAuto(
  inputPoints: readonly LocalDemGatewayAutoPoint[],
  signal?: AbortSignal
): Promise<Map<number, LocalDemGatewaySample> | null> {
  const configuration = await resolvedGatewayConfiguration();
  if (!configuration) return null;
  const endpoint = endpointUrl(configuration);
  if (!endpoint) return null;
  const endpointKey = endpoint.toString();
  if (blockedEndpoint === endpointKey && blockedUntil > Date.now()) return null;

  const points = inputPoints.filter((point) =>
    Number.isInteger(point.index) && point.index >= 0 && isJapanPoint(point)
  );
  if (points.length === 0) return new Map();

  const resolved = new Map<number, LocalDemGatewaySample>();
  for (let offset = 0; offset < points.length; offset += MAX_POINTS_PER_REQUEST) {
    const chunk = points.slice(offset, offset + MAX_POINTS_PER_REQUEST);
    try {
      const chunkResults = await requestAutoChunk(
        configuration,
        endpoint,
        chunk,
        signal
      );
      for (const [index, sample] of chunkResults) resolved.set(index, sample);
      if (blockedEndpoint === endpointKey) {
        blockedEndpoint = null;
        blockedUntil = 0;
      }
    } catch {
      if (signal?.aborted) throw createAbortError();
      blockedEndpoint = endpointKey;
      blockedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return null;
    }
  }
  return resolved;
}

/**
 * Resolve one existing precision tier through the private E-drive origin.
 * Any origin/network/validation failure returns an empty or partial map so the
 * caller continues to the existing GSI path. No failure is interpreted as sea
 * level or NoData, preserving the current terrain semantics.
 */
export async function lookupLocalDemGatewayForSource(
  source: LocalDemGatewaySource,
  inputPoints: readonly LocalDemGatewayPoint[],
  signal?: AbortSignal
): Promise<Map<number, number>> {
  const configuration = await resolvedGatewayConfiguration();
  if (!configuration) return new Map();
  const endpoint = endpointUrl(configuration);
  if (!endpoint) return new Map();
  const endpointKey = endpoint.toString();
  if (blockedEndpoint === endpointKey && blockedUntil > Date.now()) return new Map();

  const points = inputPoints.filter((point) =>
    Number.isInteger(point.index) && point.index >= 0 && isJapanPoint(point)
  );
  if (points.length === 0) return new Map();

  const resolved = new Map<number, number>();
  for (let offset = 0; offset < points.length; offset += MAX_POINTS_PER_REQUEST) {
    const chunk = points.slice(offset, offset + MAX_POINTS_PER_REQUEST);
    try {
      const chunkResults = await requestChunk(
        configuration,
        endpoint,
        source,
        chunk,
        signal
      );
      for (const [index, heightMeters] of chunkResults) resolved.set(index, heightMeters);
      if (blockedEndpoint === endpointKey) {
        blockedEndpoint = null;
        blockedUntil = 0;
      }
    } catch {
      if (signal?.aborted) throw createAbortError();
      blockedEndpoint = endpointKey;
      blockedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      break;
    }
  }
  return resolved;
}

/** Regression tests only. */
export function resetLocalDemGatewayForTests(): void {
  blockedEndpoint = null;
  blockedUntil = 0;
  blockedProfileEndpoint = null;
  blockedProfileUntil = 0;
  blockedComputedProfileEndpoint = null;
  blockedComputedProfileUntil = 0;
}
