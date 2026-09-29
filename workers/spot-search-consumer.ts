import { runWithServerRuntime } from "../server/cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "../server/r2PersistentCache.ts";
import { runSpotSearchJob } from "../server/runSpotSearchJob.ts";
import {
  createSpotSearchJobUpdater,
  getSpotSearchJob,
  type SpotSearchJobKv,
  type SpotSearchQueueMessage,
} from "../server/spotSearchJobs.ts";
import type { LocalDemEndpointRegistry } from "../server/localDemEndpointRegistry.ts";

interface ConsumerEnv {
  SPOT_SEARCH_JOBS: KVNamespace;
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  LOCAL_DEM_API_URL?: string;
  LOCAL_DEM_ORIGIN_TOKEN?: string;
  LOCAL_DEM_ACCESS_CLIENT_ID?: string;
  LOCAL_DEM_ACCESS_CLIENT_SECRET?: string;
  NETWORK_CACHE?: R2Bucket;
  R2_WRITE_BUDGET_DB?: D1Database;
}

function isQueueMessage(value: unknown): value is SpotSearchQueueMessage {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "job" in value && typeof value.job === "object" && value.job !== null;
}

export default {
  async queue(
    batch: MessageBatch<SpotSearchQueueMessage>,
    env: ConsumerEnv,
    context: ExecutionContext
  ): Promise<void> {
    const kv = env.SPOT_SEARCH_JOBS as unknown as SpotSearchJobKv;

    for (const message of batch.messages) {
      // リクエスト単位の予算（R2_MAX_READS_PER_REQUEST等）をメッセージごとに
      // 独立させるため、configureServerRuntimeはメッセージごとに呼び直す
      // （バッチ全体で1回だけ呼ぶと、persistentCacheFromR2の識別子として
      // 未定義のmessageを参照してしまいコンパイルエラーになっていた）。
      await runWithServerRuntime({
        cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
        // DEMタイル本体・空判定はR2（NETWORK_CACHE）で永続化し、全ユーザー・
        // 全検索ジョブで共有する（server/r2PersistentCache.ts）。Workers KV
        // へは書き込まない方針は維持（server/gsiElevation.tsのコメント参照）。
        persistentCache: persistentCacheFromR2(
          env.NETWORK_CACHE,
          env.SPOT_SEARCH_JOBS,
          message as object,
          env.R2_WRITE_BUDGET_DB,
        ),
        waitUntil: (promise) => context.waitUntil(promise),
        r2WriteBudgetDb: env.R2_WRITE_BUDGET_DB,
        localDemGateway: {
          endpoint: env.LOCAL_DEM_API_URL,
          originToken: env.LOCAL_DEM_ORIGIN_TOKEN,
          accessClientId: env.LOCAL_DEM_ACCESS_CLIENT_ID,
          accessClientSecret: env.LOCAL_DEM_ACCESS_CLIENT_SECRET,
          endpointRegistry: env.SPOT_SEARCH_JOBS as unknown as LocalDemEndpointRegistry,
        },
      }, async () => {

      if (!isQueueMessage(message.body)) {
        message.ack();
        return;
      }
      const queuedJob = message.body.job;
      try {
        const storedJob = await getSpotSearchJob(
          kv,
          queuedJob.clientId,
          queuedJob.jobId
        );
        if (storedJob &&
          (storedJob.status === "complete" || storedJob.status === "awaiting-3d" ||
            storedJob.status === "failed")) {
          message.ack();
          return;
        }
        const activeJob = storedJob ?? queuedJob;
        await runSpotSearchJob(
          activeJob,
          createSpotSearchJobUpdater(kv, activeJob, {
            source: "queue/spot-search-consumer",
            requestId: message.id,
            queueAttempt: message.attempts,
          })
        );
        message.ack();
      } catch (error) {
        if (message.attempts < 3) {
          message.retry({ delaySeconds: Math.min(60, 5 * message.attempts) });
          return;
        }
        const updateJob = createSpotSearchJobUpdater(kv, queuedJob, {
          source: "queue/spot-search-consumer:terminal-failure",
          requestId: message.id,
          queueAttempt: message.attempts,
        });
        await updateJob(queuedJob.clientId, queuedJob.jobId, {
          status: "failed",
          progress: "検索に失敗しました",
          progressPercent: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        message.ack();
      }
      });
    }
  },
} satisfies ExportedHandler<ConsumerEnv, SpotSearchQueueMessage>;
