import { createAbortError, createTimeoutError } from "../utils/runtimeErrors";
import type { GsiElevationApiSample } from "../types/geospatial";

export type GsiElevationClientPoint = {
  latitude: number;
  longitude: number;
  maximumDetail?: "1m" | "5m" | "10m";
  interpolationMode?: "los-safe" | "neutral";
};

export type GsiElevationClientResult = {
  samples: GsiElevationApiSample[];
  failedPointCount: number;
  lastError: unknown;
  /**
   * 2026-08-28追記: R2キャッシュ（DEMタイル単位）が実際に活用されて
   * いるかを診断できるよう、実際のタイル取得回数でのヒット/ミス回数を
   * 集計する。「地形取得◯点」という座標の集計とは別に、「そのうち
   * 何回分のタイル参照で、実際にキャッシュが再利用されたか」を確認
   * できるようにする。
   */
  tileCacheHitCount: number;
  tileCacheMissCount: number;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// 1リクエストあたりの点数と同時実行数。標高APIはGSIタイルCDN＋R2キャッシュに
// 裏付けられた通常のAPIであり、応答が不安定な国土地理院ジオイドCGIとは事情が
// 異なるため、ここは純粋な通信I/Oの並列度を上げるだけで安全に速くできる
// （CPU/GPUを使う計算ではないため、端末性能に応じて絞る必要がない）。
// 適応精密化により1天体あたりの要求点数を大幅に削減したため、過剰な16並列は
// 不要。スマホ回線やCloudflare/GSI側へ瞬間的に負荷を集中させない8並列に制限し、
// スループットを維持しつつ一時失敗・輻輳を減らす。座標やDEM詳細度は間引かない。
const REQUEST_BATCH_SIZE = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_REQUESTS = 8;
const SINGLE_POINT_RETRY_DELAY_MS = 250;

// 2026-08-28追記: 「R2キャッシュ（DEMタイル単位）が実際に活用されて
// いるか」を、通信フローの型シグネチャ（TerrainSampler等）を変えずに
// 診断できるよう、モジュールレベルでヒット/ミス回数を記録する
// （フリーズ検知freezeDetector.tsと同じ設計パターン）。検索1回ごとに
// リセットして使う。
let globalCacheHitCount = 0;
let globalCacheMissCount = 0;

export function resetGsiElevationCacheStats(): void {
  globalCacheHitCount = 0;
  globalCacheMissCount = 0;
}

export function getGsiElevationCacheStats(): {
  hit: number;
  miss: number;
} {
  return { hit: globalCacheHitCount, miss: globalCacheMissCount };
}

function emptySamples(count: number): GsiElevationApiSample[] {
  return Array.from({ length: count }, () => ({ heightMeters: null, source: null }));
}

function abortError(): Error {
  return createAbortError("標高取得を中止しました");
}

type BatchFetchResult = {
  samples: GsiElevationApiSample[];
  /**
   * 2026-08-28追記: 「複数点まとめた外側のバッチキャッシュ」（三脚探索
   * では意味をなさなかった）は撤去し、実際に効果のある「DEMタイル単位」
   * のヒット/ミス回数をそのままサーバーから受け取る。
   */
  tileCacheHit: number;
  tileCacheMiss: number;
};

async function requestBatch(
  points: GsiElevationClientPoint[],
  signal: AbortSignal | undefined,
  fetcher: FetchLike
): Promise<BatchFetchResult> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(createTimeoutError("国土地理院標高APIがタイムアウトしました")),
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
    const data = (await response.json()) as {
      samples?: unknown;
      error?: unknown;
      tileCacheHit?: unknown;
      tileCacheMiss?: unknown;
    };
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
    // 2026-08-28追記: R2キャッシュが実際に「ヒット」しているのか
    // 「毎回ミスして国土地理院に問い合わせ直している」のかを、
    // これまでクライアント側では一切確認できていなかった
    // （サーバー側は正しく返していたが、受け取っていなかった）。
    // 診断情報として、この後の集計に使えるよう保持する。
    return {
      samples: data.samples as GsiElevationApiSample[],
      tileCacheHit: typeof data.tileCacheHit === "number" ? data.tileCacheHit : 0,
      tileCacheMiss: typeof data.tileCacheMiss === "number" ? data.tileCacheMiss : 0,
    };
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
) => Promise<BatchFetchResult>;

// 2026-08-25追記: 以前は fetchGsiElevationSamples が呼ばれるたびに、
// 呼び出し1回ごとに専用の「8並列までのキュー」を新規作成していた。
// 三脚探索では複数の天体（太陽・月・天の川・北極星）や、収束計算の
// 各段階が並行して fetchGsiElevationSamples を呼ぶため、実際には
// 「8並列 × 同時に動いている呼び出し数」ぶんのリクエストが同時に
// ブラウザから飛んでいた（実機で瞬間的に数十本規模になり、一部が
// 詰まって失敗 → requestBatchWithRecovery の分割再送でさらに
// リクエストが増える、という悪循環の火種になっていた）。
// ここをアプリ全体で1つだけの共有キューに変え、「同時に実際へ飛ぶ
// リクエストは常に最大8本まで」という制限を、呼び出し元の数によらず
// 確実に守るようにする。
type ScheduledJob = {
  points: GsiElevationClientPoint[];
  signal: AbortSignal | undefined;
  fetcher: FetchLike;
  resolve: (result: BatchFetchResult) => void;
  reject: (error: unknown) => void;
};

const sharedQueue: ScheduledJob[] = [];
let sharedActiveRequests = 0;

function pumpSharedQueue(): void {
  while (sharedActiveRequests < MAX_CONCURRENT_REQUESTS && sharedQueue.length > 0) {
    const job = sharedQueue.shift();
    if (!job) return;
    if (job.signal?.aborted) {
      job.reject(abortError());
      continue;
    }
    sharedActiveRequests += 1;
    void requestBatch(job.points, job.signal, job.fetcher)
      .then(job.resolve, job.reject)
      .finally(() => {
        sharedActiveRequests -= 1;
        pumpSharedQueue();
      });
  }
}

function createRequestScheduler(
  signal: AbortSignal | undefined,
  fetcher: FetchLike
): ScheduledRequest {
  return (points) => new Promise<BatchFetchResult>((resolve, reject) => {
    sharedQueue.push({ points, signal, fetcher, resolve, reject });
    pumpSharedQueue();
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

// バッチ失敗時の「半分に分割して再送」は、失敗の原因が輻輳（同時接続数の
// 限界による詰まり）だった場合、分割のたびにリクエスト数が倍増し、輻輳を
// さらに悪化させる正のフィードバックループを引き起こしうる（実機で64点の
// バッチが最悪1点単位まで分裂し、497件のリクエストに膨れ上がる不具合が
// 実際に発生した）。これを防ぐため、
//   1) 1点まで無限に分割せず、MIN_RECOVERY_SPLIT_SIZE点で分割を打ち切り、
//      それ未満はバックオフを挟んでそのまま再送する
//   2) 分割・再送の前に必ず短い間隔を空け、輻輳が収まる猶予を与える
// の2点を徹底する。
const MIN_RECOVERY_SPLIT_SIZE = 8;

async function requestBatchWithRecovery(
  points: GsiElevationClientPoint[],
  signal: AbortSignal | undefined,
  request: ScheduledRequest
): Promise<GsiElevationClientResult> {
  const emptyCacheCounts = { tileCacheHitCount: 0, tileCacheMissCount: 0 };
  try {
    const result = await request(points);
    return {
      samples: result.samples,
      failedPointCount: 0,
      lastError: null,
      tileCacheHitCount: result.tileCacheHit,
      tileCacheMissCount: result.tileCacheMiss,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (points.length <= MIN_RECOVERY_SPLIT_SIZE) {
      try {
        await waitForSinglePointRetry(signal);
        const result = await request(points);
        return {
          samples: result.samples,
          failedPointCount: 0,
          lastError: null,
          tileCacheHitCount: result.tileCacheHit,
          tileCacheMissCount: result.tileCacheMiss,
        };
      } catch (retryError) {
        if (signal?.aborted) {
          throw abortError();
        }
        return {
          samples: emptySamples(points.length),
          failedPointCount: points.length,
          lastError: retryError,
          ...emptyCacheCounts,
        };
      }
    }

    // 分割前に一呼吸置く。輻輳が原因で失敗した場合、間を空けずに即座に
    // 倍のリクエストを再投入すると輻輳をさらに悪化させるため。
    await waitForSinglePointRetry(signal);
    const middle = Math.ceil(points.length / 2);
    const [left, right] = await Promise.all([
      requestBatchWithRecovery(points.slice(0, middle), signal, request),
      requestBatchWithRecovery(points.slice(middle), signal, request),
    ]);
    return {
      samples: [...left.samples, ...right.samples],
      failedPointCount: left.failedPointCount + right.failedPointCount,
      lastError: right.lastError ?? left.lastError ?? error,
      tileCacheHitCount: left.tileCacheHitCount + right.tileCacheHitCount,
      tileCacheMissCount: left.tileCacheMissCount + right.tileCacheMissCount,
    };
  }
}

export async function fetchGsiElevationSamples(
  points: GsiElevationClientPoint[],
  signal?: AbortSignal,
  fetcher: FetchLike = fetch
): Promise<GsiElevationClientResult> {
  if (points.length === 0) {
    return { samples: [], failedPointCount: 0, lastError: null, tileCacheHitCount: 0, tileCacheMissCount: 0 };
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
  const finalResult = {
    samples: results.flatMap((result) => result.samples),
    failedPointCount: results.reduce((sum, result) => sum + result.failedPointCount, 0),
    lastError: results.findLast((result) => result.lastError)?.lastError ?? null,
    tileCacheHitCount: results.reduce((sum, result) => sum + result.tileCacheHitCount, 0),
    tileCacheMissCount: results.reduce((sum, result) => sum + result.tileCacheMissCount, 0),
  };
  globalCacheHitCount += finalResult.tileCacheHitCount;
  globalCacheMissCount += finalResult.tileCacheMissCount;
  return finalResult;
}
