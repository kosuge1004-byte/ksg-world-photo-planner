import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "../../server/r2PersistentCache.ts";
import type {
  SpotSearchJobKv,
  SpotSearchQueueMessage,
} from "../../server/spotSearchJobs.ts";

export interface CloudflareEnv {
  ASSETS: Fetcher;
  SPOT_SEARCH_JOBS: KVNamespace;
  SPOT_SEARCH_QUEUE: Queue<SpotSearchQueueMessage>;
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  GOOGLE_MAPS_API_KEY?: string;
  NETWORK_CACHE?: R2Bucket;
  /**
   * 2026-08-27追記: R2月間書き込み総数を数えるためのD1データベース。
   * KVより無料枠が100倍大きく(D1書き込み10万回/日 vs KV書き込み1000回/日)、
   * Pages Functionsに直接バインディングできるため採用。
   * server/r2SafetyBudget.tsのR2MonthlyBudgetDb参照。
   */
  R2_WRITE_BUDGET_DB?: D1Database;
}

export function spotSearchJobKv(env: CloudflareEnv): SpotSearchJobKv {
  return env.SPOT_SEARCH_JOBS as unknown as SpotSearchJobKv;
}

export function configureCloudflareServerRuntime(
  context: EventContext<CloudflareEnv, string, unknown>,
  disablePersistentCache = false
): void {
  configureServerRuntime({
    cesiumIonToken:
      context.env.CESIUM_ION_TOKEN ?? context.env.VITE_CESIUM_ION_TOKEN,
    persistentCache: disablePersistentCache
      ? undefined
      : persistentCacheFromR2(
          context.env.NETWORK_CACHE,
          context.env.SPOT_SEARCH_JOBS,
          context.request,
          context.env.R2_WRITE_BUDGET_DB,
        ),
    waitUntil: (promise) => context.waitUntil(promise),
    r2WriteBudgetDb: context.env.R2_WRITE_BUDGET_DB,
  });
}
