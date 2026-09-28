import {
  serverLocalDemGateway,
  type LocalDemGatewayConfiguration,
} from "./cloudflareRuntime.ts";
import { createAbortError, createTimeoutError } from "./runtimeErrors.ts";

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

const MAX_POINTS_PER_REQUEST = 512;
const REQUEST_TIMEOUT_MS = 2_000;
const FAILURE_COOLDOWN_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MIN_HEIGHT_METERS = -500;
const MAX_HEIGHT_METERS = 10_000;

let blockedEndpoint: string | null = null;
let blockedUntil = 0;

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
    return url;
  } catch {
    return null;
  }
}

function isJapanPoint(point: LocalDemGatewayPoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    point.latitude >= 20 && point.latitude <= 46.5 &&
    point.longitude >= 122 && point.longitude <= 154;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
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
      if (length > MAX_RESPONSE_BYTES) {
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

async function requestChunk(
  configuration: Required<LocalDemGatewayConfiguration>,
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
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "CF-Access-Client-Id": configuration.accessClientId,
        "CF-Access-Client-Secret": configuration.accessClientSecret,
        "X-AstroSight-Origin-Token": configuration.originToken,
      },
      body: JSON.stringify({ source, points }),
      cache: "no-store",
      redirect: "error",
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
  const configuration = serverLocalDemGateway();
  if (!configuration) return new Map();
  const endpoint = endpointUrl(configuration);
  if (!endpoint) return new Map();
  const endpointKey = endpoint.toString();
  if (blockedEndpoint === endpointKey && blockedUntil > Date.now()) return new Map();

  const points = inputPoints.filter((point) =>
    Number.isInteger(point.index) && point.index >= 0 && isJapanPoint(point)
  );
  if (points.length === 0) return new Map();

  const completeConfiguration = configuration as Required<LocalDemGatewayConfiguration>;
  const resolved = new Map<number, number>();
  for (let offset = 0; offset < points.length; offset += MAX_POINTS_PER_REQUEST) {
    const chunk = points.slice(offset, offset + MAX_POINTS_PER_REQUEST);
    try {
      const chunkResults = await requestChunk(
        completeConfiguration,
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
}
