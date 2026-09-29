import {
  runWithServerRuntime,
  type RuntimeConfiguration,
} from "../../server/cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "../../server/r2PersistentCache.ts";
import type {
  SpotSearchJobKv,
  SpotSearchQueueMessage,
} from "../../server/spotSearchJobs.ts";
import type {
  BearingProfileDownloadJobKv,
  BearingProfileDownloadQueueMessage,
} from "../../server/bearingProfileDownloadJobs.ts";
import type { LocalDemEndpointRegistry } from "../../server/localDemEndpointRegistry.ts";

export interface CloudflareEnv {
  ASSETS: Fetcher;
  SPOT_SEARCH_JOBS: KVNamespace;
  SPOT_SEARCH_QUEUE: Queue<SpotSearchQueueMessage>;
  /**
   * 2026-09-08追記: 三脚候補周辺データダウンロードのサーバー側バックグラウンド
   * ジョブ用。R2/D1と同じ理由で、実際に作成するまではoptionalとして扱い、
   * 未設定でもPages/Workerのビルド・デプロイ自体は失敗しない。
   */
  BEARING_PROFILE_DOWNLOAD_JOBS?: KVNamespace;
  BEARING_PROFILE_DOWNLOAD_QUEUE?: Queue<BearingProfileDownloadQueueMessage>;
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  GOOGLE_MAPS_API_KEY?: string;
  /** HTTPS endpoint published by Cloudflare Tunnel. Never points at a drive/share. */
  LOCAL_DEM_API_URL?: string;
  /** Origin-level shared secret; configure as a Cloudflare secret. */
  LOCAL_DEM_ORIGIN_TOKEN?: string;
  /** Cloudflare Access service-token credentials; configure both as secrets. */
  LOCAL_DEM_ACCESS_CLIENT_ID?: string;
  LOCAL_DEM_ACCESS_CLIENT_SECRET?: string;
  /** Authenticates a domainless Quick Tunnel heartbeat; Pages only. */
  LOCAL_DEM_REGISTRATION_TOKEN?: string;
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

export function bearingProfileDownloadJobKv(env: CloudflareEnv): BearingProfileDownloadJobKv | null {
  return env.BEARING_PROFILE_DOWNLOAD_JOBS
    ? (env.BEARING_PROFILE_DOWNLOAD_JOBS as unknown as BearingProfileDownloadJobKv)
    : null;
}

function cloudflareServerRuntimeConfiguration(
  context: EventContext<CloudflareEnv, string, unknown>
): RuntimeConfiguration {
  return {
    cesiumIonToken:
      context.env.CESIUM_ION_TOKEN ?? context.env.VITE_CESIUM_ION_TOKEN,
    persistentCache: persistentCacheFromR2(
      context.env.NETWORK_CACHE,
      context.env.SPOT_SEARCH_JOBS,
      context.request,
      context.env.R2_WRITE_BUDGET_DB,
    ),
    waitUntil: (promise) => context.waitUntil(promise),
    r2WriteBudgetDb: context.env.R2_WRITE_BUDGET_DB,
    localDemGateway: {
      endpoint: context.env.LOCAL_DEM_API_URL,
      originToken: context.env.LOCAL_DEM_ORIGIN_TOKEN,
      accessClientId: context.env.LOCAL_DEM_ACCESS_CLIENT_ID,
      accessClientSecret: context.env.LOCAL_DEM_ACCESS_CLIENT_SECRET,
      endpointRegistry: context.env.SPOT_SEARCH_JOBS as unknown as LocalDemEndpointRegistry,
    },
  };
}

/** Keep request-bound bindings and credentials isolated across concurrent requests. */
export function withCloudflareServerRuntime<T>(
  context: EventContext<CloudflareEnv, string, unknown>,
  task: () => T
): T {
  return runWithServerRuntime(cloudflareServerRuntimeConfiguration(context), task);
}
