import type { GsiElevationApiSample } from "../types/geospatial";

export type GsiElevationClientPoint = {
  latitude: number;
  longitude: number;
  maximumDetail?: "1m" | "5m" | "10m";
};

export type GsiElevationClientResult = {
  samples: GsiElevationApiSample[];
  failedPointCount: number;
  lastError: unknown;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_BATCH_SIZE = 32;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 2;
const SINGLE_POINT_RETRY_DELAY_MS = 250;

function emptySamples(count: number): GsiElevationApiSample[] {
  return Array.from({ length: count }, () => ({ heightMeters: null, source: null }));
}

function abortError(): DOMException {
  return new DOMException("標高取得を中止しました", "AbortError");
}

async function requestBatch(
  points: GsiElevationClientPoint[],
  signal: AbortSignal | undefined,
  fetcher: FetchLike
): Promise<GsiElevationApiSample[]> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("国土地理院標高APIがタイムアウトしました", "TimeoutError")),
    REQUEST_TIMEOUT_MS
  );
  const onAbort = () => controller.abort(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetcher("/api/gsi-elevation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ points }),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`国土地理院標高APIがJSON以外を返しました（${response.status}）`);
    }
    const data = (await response.json()) as { samples?: unknown; error?: unknown };
    if (!response.ok || !Array.isArray(data.samples)) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : `国土地理院標高APIエラー：${response.status}`
      );
    }
    if (data.samples.length !== points.length) {
      throw new Error("国土地理院標高APIの応答点数が一致しません");
    }
    return data.samples as GsiElevationApiSample[];
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

type ScheduledRequest = (
  points: GsiElevationClientPoint[]
) => Promise<GsiElevationApiSample[]>;

function createRequestScheduler(
  signal: AbortSignal | undefined,
  fetcher: FetchLike
): ScheduledRequest {
  type Job = {
    points: GsiElevationClientPoint[];
    resolve: (samples: GsiElevationApiSample[]) => void;
    reject: (error: unknown) => void;
  };

  const queue: Job[] = [];
  let activeRequests = 0;

  const pump = (): void => {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      if (signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      activeRequests += 1;
      void requestBatch(job.points, signal, fetcher)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeRequests -= 1;
          pump();
        });
    }
  };

  return (points) => new Promise<GsiElevationApiSample[]>((resolve, reject) => {
    queue.push({ points, resolve, reject });
    pump();
  });
}

async function waitForSinglePointRetry(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, SINGLE_POINT_RETRY_DELAY_MS);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      setTimeout(() => signal.removeEventListener("abort", onAbort), SINGLE_POINT_RETRY_DELAY_MS);
    }
  });
}

async function requestBatchWithRecovery(
  points: GsiElevationClientPoint[],
  signal: AbortSignal | undefined,
  request: ScheduledRequest
): Promise<GsiElevationClientResult> {
  try {
    return {
      samples: await request(points),
      failedPointCount: 0,
      lastError: null,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (points.length === 1) {
      try {
        await waitForSinglePointRetry(signal);
        return {
          samples: await request(points),
          failedPointCount: 0,
          lastError: null,
        };
      } catch (retryError) {
        if (signal?.aborted) {
          throw abortError();
        }
        return {
          samples: emptySamples(points.length),
          failedPointCount: points.length,
          lastError: retryError,
        };
      }
    }

    const middle = Math.ceil(points.length / 2);
    const [left, right] = await Promise.all([
      requestBatchWithRecovery(points.slice(0, middle), signal, request),
      requestBatchWithRecovery(points.slice(middle), signal, request),
    ]);
    return {
      samples: [...left.samples, ...right.samples],
      failedPointCount: left.failedPointCount + right.failedPointCount,
      lastError: right.lastError ?? left.lastError ?? error,
    };
  }
}

export async function fetchGsiElevationSamples(
  points: GsiElevationClientPoint[],
  signal?: AbortSignal,
  fetcher: FetchLike = fetch
): Promise<GsiElevationClientResult> {
  if (points.length === 0) {
    return { samples: [], failedPointCount: 0, lastError: null };
  }
  const batches = Array.from(
    { length: Math.ceil(points.length / REQUEST_BATCH_SIZE) },
    (_, index) => points.slice(
      index * REQUEST_BATCH_SIZE,
      (index + 1) * REQUEST_BATCH_SIZE
    )
  );
  const results = new Array<GsiElevationClientResult>(batches.length);
  const request = createRequestScheduler(signal, fetcher);
  let nextBatchIndex = 0;

  async function worker(): Promise<void> {
    while (nextBatchIndex < batches.length) {
      const index = nextBatchIndex;
      nextBatchIndex += 1;
      results[index] = await requestBatchWithRecovery(batches[index], signal, request);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_REQUESTS, batches.length) },
    () => worker()
  ));
  return {
    samples: results.flatMap((result) => result.samples),
    failedPointCount: results.reduce((sum, result) => sum + result.failedPointCount, 0),
    lastError: results.findLast((result) => result.lastError)?.lastError ?? null,
  };
}
