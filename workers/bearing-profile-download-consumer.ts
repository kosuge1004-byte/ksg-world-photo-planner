import { runWithServerRuntime } from "../server/cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "../server/r2PersistentCache.ts";
import { runBearingProfileDownloadJob } from "../server/runBearingProfileDownloadJob.ts";
import {
  createBearingProfileDownloadJobUpdater,
  getBearingProfileDownloadJob,
  type BearingProfileDownloadJobKv,
  type BearingProfileDownloadQueueMessage,
} from "../server/bearingProfileDownloadJobs.ts";

interface ConsumerEnv {
  BEARING_PROFILE_DOWNLOAD_JOBS: KVNamespace;
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  LOCAL_DEM_API_URL?: string;
  LOCAL_DEM_ORIGIN_TOKEN?: string;
  LOCAL_DEM_ACCESS_CLIENT_ID?: string;
  LOCAL_DEM_ACCESS_CLIENT_SECRET?: string;
  NETWORK_CACHE?: R2Bucket;
  R2_WRITE_BUDGET_DB?: D1Database;
}

function isQueueMessage(value: unknown): value is BearingProfileDownloadQueueMessage {
  return typeof value === "object" && value !== null &&
    "version" in value && value.version === 1 &&
    "job" in value && typeof value.job === "object" && value.job !== null;
}

export default {
  async queue(
    batch: MessageBatch<BearingProfileDownloadQueueMessage>,
    env: ConsumerEnv,
    context: ExecutionContext
  ): Promise<void> {
    const kv = env.BEARING_PROFILE_DOWNLOAD_JOBS as unknown as BearingProfileDownloadJobKv;

    for (const message of batch.messages) {
      // spot-search-consumerと同じ理由: リクエスト単位の予算をメッセージごとに
      // 独立させるため、configureServerRuntimeはメッセージごとに呼び直す。
      await runWithServerRuntime({
        cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
        // DEMタイル本体・空判定はR2（NETWORK_CACHE）で永続化し、対話的な
        // ライブ三脚探索とこのバックグラウンドジョブの両方で共有する。
        // これにより、ジョブ完了後に端末がprefetchGsiDeviceTilesForSamples等で
        // 実タイルを取りに行く際、既に温まったR2キャッシュから高速に読める。
        persistentCache: persistentCacheFromR2(
          env.NETWORK_CACHE,
          env.BEARING_PROFILE_DOWNLOAD_JOBS,
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
        },
      }, async () => {

      if (!isQueueMessage(message.body)) {
        message.ack();
        return;
      }
      const queuedJob = message.body.job;
      try {
        const storedJob = await getBearingProfileDownloadJob(kv, queuedJob.clientId, queuedJob.jobId);
        if (storedJob && (storedJob.status === "complete" || storedJob.status === "failed")) {
          message.ack();
          return;
        }
        const activeJob = storedJob ?? queuedJob;
        await runBearingProfileDownloadJob(
          activeJob,
          createBearingProfileDownloadJobUpdater(kv, activeJob, {
            source: "queue/bearing-profile-download-consumer",
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
        const updateJob = createBearingProfileDownloadJobUpdater(kv, queuedJob, {
          source: "queue/bearing-profile-download-consumer:terminal-failure",
          requestId: message.id,
          queueAttempt: message.attempts,
        });
        await updateJob({
          status: "failed",
          progress: "ダウンロードに失敗しました",
          progressPercent: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        message.ack();
      }
      });
    }
  },
} satisfies ExportedHandler<ConsumerEnv, BearingProfileDownloadQueueMessage>;
