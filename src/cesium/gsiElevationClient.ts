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
  tileMemoryHitCount: number;
  tileCacheSharedCount: number;
  tileCacheBypassCount: number;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// 1リクエストあたりの点数と同時実行数。標高APIはGSIタイルCDN＋R2キャッシュに
// 裏付けられた通常のAPIであり、応答が不安定な国土地理院ジオイドCGIとは事情が
// 異なるため、ここは純粋な通信I/Oの並列度を上げるだけで安全に速くできる
// （CPU/GPUを使う計算ではないため、端末性能に応じて絞る必要がない）。
// 適応精密化により1天体あたりの要求点数を大幅に削減したため、過剰な16並列は
// 不要。スマホ回線やCloudflare/GSI側へ瞬間的に負荷を集中させない8並列に制限し、
// スループットを維持しつつ一時失敗・輻輳を減らす。座標やDEM詳細度は間引かない。
// 2026-08-29実機診断: 三脚初期探索は最大640点規模を1回のterrainSamplerで
// 要求するのに、クライアントが64点ごとに分割していたため、同一探索段階だけで
// 最大10本のHTTP往復が発生していた。サーバー/API側は1リクエスト最大2000点を
// 正式に受理し、内部では同一DEMタイルを共有して処理する。そこで640点を丸ごと
// 1要求に収められる1024点へ拡大する。座標・順序・maximumDetail・補間方式・
// DEMソース優先順位・再試行条件は一切変更せず、HTTP分割境界だけを変更する。
// これにより精度を変えず、初期探索のHTTP往復とサーバー側の重複タイル処理を削減する。
const REQUEST_BATCH_SIZE = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
// 2026-09-02変更（実機での試験目的、利用者の判断により）: Cloudflare
// Workerはリクエストごとに自動スケールするため8という上限自体の根拠は
// 薄く、8→10で実機の挙動（特にDEM未キャッシュの地方エリアでGSI原本
// サーバー側のレート制限に引っかからないか）を確認する試験的な変更。
// 悪化が見られた場合は8へ戻す。
const MAX_CONCURRENT_REQUESTS = 10;
const SINGLE_POINT_RETRY_DELAY_MS = 250;

// 2026-08-28追記: 「R2キャッシュ（DEMタイル単位）が実際に活用されて
// いるか」を、通信フローの型シグネチャ（TerrainSampler等）を変えずに
// 診断できるよう、モジュールレベルでヒット/ミス回数を記録する
// （フリーズ検知freezeDetector.tsと同じ設計パターン）。検索1回ごとに
// リセットして使う。
let globalCacheHitCount = 0;
let globalCacheMissCount = 0;
let globalMemoryHitCount = 0;
let globalCacheSharedCount = 0;
let globalCacheBypassCount = 0;

export function resetGsiElevationCacheStats(): void {
  globalCacheHitCount = 0;
  globalCacheMissCount = 0;
  globalMemoryHitCount = 0;
  globalCacheSharedCount = 0;
  globalCacheBypassCount = 0;
}

export function getGsiElevationCacheStats(): {
  hit: number;
  miss: number;
  memoryHit: number;
  shared: number;
  bypass: number;
} {
  return {
    hit: globalCacheHitCount,
    miss: globalCacheMissCount,
    memoryHit: globalMemoryHitCount,
    shared: globalCacheSharedCount,
    bypass: globalCacheBypassCount,
  };
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
  tileMemoryHit: number;
  tileCacheShared: number;
  tileCacheBypass: number;
};

function diagnosticCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

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
      tileMemoryHit?: unknown;
      tileCacheShared?: unknown;
      tileCacheBypass?: unknown;
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
      tileCacheHit: diagnosticCount(data.tileCacheHit),
      tileCacheMiss: diagnosticCount(data.tileCacheMiss),
      tileMemoryHit: diagnosticCount(data.tileMemoryHit),
      tileCacheShared: diagnosticCount(data.tileCacheShared),
      tileCacheBypass: diagnosticCount(data.tileCacheBypass),
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
let sharedActiveLargeRequests = 0;

// 2026-09-01追記（実機診断より）: 三脚候補探索は複数の天体（太陽・月等）を
// 同時に探索することがあり、それぞれが独立して「1呼び出しあたり最大
// MAX_CONCURRENT_REQUESTS-2まで」に自制しても、2つの探索が合わされば
// グローバルな8スロットを合計で埋め尽くしてしまう（自制は呼び出し単位
// でしか効かず、アプリ全体として空き枠を保証できていなかった）。手動での
// 三脚ピン配置のような単発・小規模な通信が、背景の大規模探索によって
// 「通信状態は問題ないのに」長時間待たされ失敗して見える不具合が実機で
// 再現した。呼び出し側の自制ではなく、キュー自体（アプリ全体で唯一の
// 実行主体）で「大きなジョブ」が使えるスロット数に絶対的な上限を設け、
// 残りは常に「小さなジョブ」（単発の手動操作等）が使えるようにする。
const MAX_CONCURRENT_LARGE_REQUESTS = MAX_CONCURRENT_REQUESTS - 2;
// この点数以下なら「小さなジョブ」として優先枠の対象にする。手動での
// ピン配置・被写体検索の地面確定は基本的に1点、多くても数十点程度。
const SMALL_JOB_MAX_POINTS = 40;

function pumpSharedQueue(): void {
  while (sharedActiveRequests < MAX_CONCURRENT_REQUESTS && sharedQueue.length > 0) {
    const isSmall = (job: ScheduledJob) => job.points.length <= SMALL_JOB_MAX_POINTS;
    // 小さなジョブ（手動操作等）を常に最優先で探す。先着順ではなく、
    // キューのどこにあっても、グローバル枠が空いている限り真っ先に通す。
    let index = sharedQueue.findIndex(isSmall);
    if (index === -1) {
      // 小さなジョブが無ければ大きなジョブを処理するが、大きなジョブ専用の
      // 上限（MAX_CONCURRENT_LARGE_REQUESTS）に達している場合はここで待機
      // する（グローバル枠にまだ空きがあっても、それは小さなジョブが
      // 割り込んでくるための予約分なので使わない）。
      if (sharedActiveLargeRequests >= MAX_CONCURRENT_LARGE_REQUESTS) return;
      index = 0;
    }
    const job = sharedQueue[index];
    sharedQueue.splice(index, 1);
    if (job.signal?.aborted) {
      job.reject(abortError());
      continue;
    }
    const large = !isSmall(job);
    sharedActiveRequests += 1;
    if (large) sharedActiveLargeRequests += 1;
    void requestBatch(job.points, job.signal, job.fetcher)
      .then(job.resolve, job.reject)
      .finally(() => {
        sharedActiveRequests -= 1;
        if (large) sharedActiveLargeRequests -= 1;
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
  const emptyCacheCounts = {
    tileCacheHitCount: 0,
    tileCacheMissCount: 0,
    tileMemoryHitCount: 0,
    tileCacheSharedCount: 0,
    tileCacheBypassCount: 0,
  };
  try {
    const result = await request(points);
    return {
      samples: result.samples,
      failedPointCount: 0,
      lastError: null,
      tileCacheHitCount: result.tileCacheHit,
      tileCacheMissCount: result.tileCacheMiss,
      tileMemoryHitCount: result.tileMemoryHit,
      tileCacheSharedCount: result.tileCacheShared,
      tileCacheBypassCount: result.tileCacheBypass,
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
          tileMemoryHitCount: result.tileMemoryHit,
          tileCacheSharedCount: result.tileCacheShared,
          tileCacheBypassCount: result.tileCacheBypass,
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
      tileMemoryHitCount: left.tileMemoryHitCount + right.tileMemoryHitCount,
      tileCacheSharedCount: left.tileCacheSharedCount + right.tileCacheSharedCount,
      tileCacheBypassCount: left.tileCacheBypassCount + right.tileCacheBypassCount,
    };
  }
}

// 2026-09-01追記: REQUEST_BATCH_SIZE（1024点、サーバーが1要求として受理
// できる上限）と、実際にクライアントが1要求へ詰め込む点数は別の関心事
// だった。640点規模の初期探索は Math.ceil(640/1024)=1 バッチにしかならず、
// 下のMAX_CONCURRENT_REQUESTS（当時8、2026-09-02に10へ変更）の並列
// ワーカーが用意されていても実質1本
// しか動かず、その1本がGSI原本サーバーへの実問い合わせを多く含む重い
// エリアでREQUEST_TIMEOUT_MS（30秒）ぎりぎりまでかかる実測が確認された
// （elapsed=30975.3ms）。この並列という既存の仕組みを実際に活かすため、
// ある程度まとまった点数（PARALLEL_SPLIT_MIN_POINTS以上）は、最初から
// おおよそMAX_CONCURRENT_REQUESTS本に均等分割してから投げる。座標・順序・
// maximumDetail・補間方式・DEMソース優先順位・再試行条件・レスポンスの
// 組み立て方は一切変更せず、「1要求に何点詰め込むか」だけを変える。
const PARALLEL_SPLIT_MIN_POINTS = 96;
const MIN_PARALLEL_CHUNK_SIZE = 48;

function chunkSizeForRequest(totalPoints: number): number {
  if (totalPoints < PARALLEL_SPLIT_MIN_POINTS) return REQUEST_BATCH_SIZE;
  const evenSplitSize = Math.ceil(totalPoints / MAX_CONCURRENT_REQUESTS);
  return Math.min(REQUEST_BATCH_SIZE, Math.max(MIN_PARALLEL_CHUNK_SIZE, evenSplitSize));
}

export async function fetchGsiElevationSamples(
  points: GsiElevationClientPoint[],
  signal?: AbortSignal,
  fetcher: FetchLike = fetch
): Promise<GsiElevationClientResult> {
  if (points.length === 0) {
    return {
      samples: [],
      failedPointCount: 0,
      lastError: null,
      tileCacheHitCount: 0,
      tileCacheMissCount: 0,
      tileMemoryHitCount: 0,
      tileCacheSharedCount: 0,
      tileCacheBypassCount: 0,
    };
  }
  const requestChunkSize = chunkSizeForRequest(points.length);
  const batches = Array.from(
    { length: Math.ceil(points.length / requestChunkSize) },
    (_, index) => points.slice(
      index * requestChunkSize,
      (index + 1) * requestChunkSize
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

  // 2026-09-01追記（実機診断より）: sharedQueue/MAX_CONCURRENT_REQUESTSは
  // アプリ全体で共有されるグローバルな上限であり、この1回の呼び出し専用
  // ではない。上の並列分割で1回の大きな探索がMAX_CONCURRENT_REQUESTS分の
  // ワーカーを一度に起動すると、その探索が終わるまでグローバル枠を
  // 独占し、同時に発生した別の通信（手動での三脚ピン配置など、単発の
  // 地形取得）が「通信状態は問題ないのに」長時間待たされ、結果的に
  // 応答がないまま失敗して見える不具合が実機で確認された。1回の呼び出しが
  // 使うワーカー数にアプリ内キャップを設け、常に他の同時通信のための
  // 枠を残す（大規模探索自体の並列化効果は維持しつつ、独占だけを防ぐ）。
  const PER_CALL_WORKER_RESERVE = 2;
  const workerCount = Math.max(
    1,
    Math.min(MAX_CONCURRENT_REQUESTS - PER_CALL_WORKER_RESERVE, batches.length)
  );
  await Promise.all(Array.from(
    { length: workerCount },
    () => worker()
  ));
  const finalResult = {
    samples: results.flatMap((result) => result.samples),
    failedPointCount: results.reduce((sum, result) => sum + result.failedPointCount, 0),
    lastError: results.findLast((result) => result.lastError)?.lastError ?? null,
    tileCacheHitCount: results.reduce((sum, result) => sum + result.tileCacheHitCount, 0),
    tileCacheMissCount: results.reduce((sum, result) => sum + result.tileCacheMissCount, 0),
    tileMemoryHitCount: results.reduce((sum, result) => sum + result.tileMemoryHitCount, 0),
    tileCacheSharedCount: results.reduce((sum, result) => sum + result.tileCacheSharedCount, 0),
    tileCacheBypassCount: results.reduce((sum, result) => sum + result.tileCacheBypassCount, 0),
  };
  globalCacheHitCount += finalResult.tileCacheHitCount;
  globalCacheMissCount += finalResult.tileCacheMissCount;
  globalMemoryHitCount += finalResult.tileMemoryHitCount;
  globalCacheSharedCount += finalResult.tileCacheSharedCount;
  globalCacheBypassCount += finalResult.tileCacheBypassCount;
  return finalResult;
}
