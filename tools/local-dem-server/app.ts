import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalDemLookupRequest, LocalGsiDemSource } from "../../server/gsiLocalDem.ts";
import type { LocalDemServerConfig } from "./config.ts";

const ENDPOINT = "/v1/elevation/batch";
const JAPAN_BOUNDS = Object.freeze({ south: 20, north: 46.5, west: 122, east: 154 });
const SOURCES = new Set<Exclude<LocalGsiDemSource, "DEM10A">>([
  "DEM1A", "DEM5A", "DEM5B", "DEM5C", "DEM10B",
]);
const POINT_KEYS = new Set([
  "index", "latitude", "longitude", "interpolation", "interpolationMode",
]);

export type LocalDemSource = Exclude<LocalGsiDemSource, "DEM10A">;
export type LocalDemLookup = (
  source: LocalDemSource,
  requests: readonly LocalDemLookupRequest[],
  signal: AbortSignal
) => Promise<Map<number, number>>;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class RequestGate {
  private readonly maximumActive: number;
  private readonly maximumWaiting: number;
  private active = 0;
  private readonly waiting: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(maximumActive: number, maximumWaiting: number) {
    this.maximumActive = maximumActive;
    this.maximumWaiting = maximumWaiting;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new HttpError(504, "request deadline exceeded"));
    if (this.active < this.maximumActive) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    if (this.waiting.length >= this.maximumWaiting) {
      return Promise.reject(new HttpError(503, "service is busy"));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new HttpError(504, "request deadline exceeded"));
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiting.length > 0) {
        const next = this.waiting.shift();
        if (!next) break;
        next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted) continue;
        next.resolve(this.releaseFunction());
        return;
      }
      this.active -= 1;
    };
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretEquals(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function authenticated(request: IncomingMessage, config: LocalDemServerConfig): boolean {
  const originToken = request.headers["x-astrosight-origin-token"];
  return Boolean(
    typeof originToken === "string" &&
    secretEquals(originToken, config.originToken)
  );
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(bytes);
}

function readBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader)) throw new HttpError(400, "invalid content length");
    if (Number(lengthHeader) > maximumBytes) throw new HttpError(413, "request body is too large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maximumBytes) {
        fail(new HttpError(413, "request body is too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = () => fail(new HttpError(400, "request body could not be read"));
    const onAbort = () => fail(new HttpError(504, "request deadline exceeded"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsePayload(
  bytes: Buffer,
  maximumPoints: number
): { source: LocalDemSource; points: LocalDemLookupRequest[] } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  const record = objectRecord(value);
  if (!record || Object.keys(record).some((key) => key !== "source" && key !== "points")) {
    throw new HttpError(400, "request body has unsupported fields");
  }
  if (typeof record.source !== "string" || !SOURCES.has(record.source as LocalDemSource)) {
    throw new HttpError(400, "source is invalid");
  }
  if (!Array.isArray(record.points) || record.points.length < 1 || record.points.length > maximumPoints) {
    throw new HttpError(400, "points count is invalid");
  }

  const indexes = new Set<number>();
  const points = record.points.map((entry): LocalDemLookupRequest => {
    const point = objectRecord(entry);
    if (!point || Object.keys(point).some((key) => !POINT_KEYS.has(key))) {
      throw new HttpError(400, "point has unsupported fields");
    }
    if (
      !Number.isSafeInteger(point.index) ||
      (point.index as number) < 0 ||
      (point.index as number) > 10_000_000 ||
      indexes.has(point.index as number)
    ) {
      throw new HttpError(400, "point index is invalid");
    }
    const latitude = point.latitude;
    const longitude = point.longitude;
    if (
      typeof latitude !== "number" || !Number.isFinite(latitude) ||
      typeof longitude !== "number" || !Number.isFinite(longitude) ||
      latitude < JAPAN_BOUNDS.south || latitude > JAPAN_BOUNDS.north ||
      longitude < JAPAN_BOUNDS.west || longitude > JAPAN_BOUNDS.east
    ) {
      throw new HttpError(400, "point coordinate is outside supported coverage");
    }
    if (point.interpolation !== "bilinear" && point.interpolation !== "constrained-bicubic") {
      throw new HttpError(400, "point interpolation is invalid");
    }
    if (point.interpolationMode !== "los-safe" && point.interpolationMode !== "neutral") {
      throw new HttpError(400, "point interpolation mode is invalid");
    }
    indexes.add(point.index as number);
    return {
      index: point.index as number,
      latitude,
      longitude,
      interpolation: point.interpolation,
      interpolationMode: point.interpolationMode,
    };
  });
  return { source: record.source as LocalDemSource, points };
}

export function createLocalDemRequestHandler(
  config: LocalDemServerConfig,
  lookup: LocalDemLookup
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const gate = new RequestGate(
    config.maximumConcurrentRequests,
    config.maximumQueuedRequests
  );

  return async (request, response) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    timer.unref();
    request.once("aborted", () => controller.abort());
    let release: (() => void) | undefined;
    let pointCount = 0;
    let responseStatus = 500;
    try {
      const requestUrl = request.url ?? "";
      if (requestUrl === "/health" && request.method === "GET") {
        responseStatus = 200;
        writeJson(response, 200, { ok: true });
        return;
      }
      if (requestUrl !== ENDPOINT) throw new HttpError(404, "not found");
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      if (!authenticated(request, config)) throw new HttpError(401, "authentication required");
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new HttpError(415, "application/json is required");
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
        throw new HttpError(415, "content encoding is unsupported");
      }

      const body = await readBody(request, config.maximumBodyBytes, controller.signal);
      const payload = parsePayload(body, config.maximumPoints);
      pointCount = payload.points.length;
      release = await gate.acquire(controller.signal);
      const resolved = await lookup(payload.source, payload.points, controller.signal);
      if (controller.signal.aborted) throw new HttpError(504, "request deadline exceeded");
      const results = payload.points.map((point) => {
        const value = resolved.get(point.index);
        return {
          index: point.index,
          heightMeters: typeof value === "number" && Number.isFinite(value) ? value : null,
        };
      });
      responseStatus = 200;
      writeJson(response, 200, {
        source: payload.source,
        results,
        resolvedCount: results.reduce(
          (count, result) => count + (result.heightMeters === null ? 0 : 1),
          0
        ),
      });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : controller.signal.aborted
          ? 504
          : 500;
      responseStatus = status;
      if (!response.headersSent) {
        const message = error instanceof HttpError ? error.message : "request failed";
        writeJson(response, status, { error: message });
      } else {
        response.end();
      }
    } finally {
      clearTimeout(timer);
      release?.();
      // Do not log bodies, coordinates, filesystem paths, or credentials.
      console.info(JSON.stringify({
        event: "local-dem-request",
        method: request.method,
        route: request.url === ENDPOINT ? ENDPOINT : request.url === "/health" ? "/health" : "other",
        status: responseStatus,
        points: pointCount,
        durationMs: Date.now() - startedAt,
      }));
    }
  };
}

export const localDemAppInternalsForTests = {
  authenticated,
  parsePayload,
  secretEquals,
  JAPAN_BOUNDS,
};
