import { configureServerRuntime } from "../../server/cloudflareRuntime.ts";
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
}

export function spotSearchJobKv(env: CloudflareEnv): SpotSearchJobKv {
  return env.SPOT_SEARCH_JOBS as unknown as SpotSearchJobKv;
}

export function configureCloudflareServerRuntime(
  context: EventContext<CloudflareEnv, string, unknown>
): void {
  configureServerRuntime({
    cesiumIonToken:
      context.env.CESIUM_ION_TOKEN ?? context.env.VITE_CESIUM_ION_TOKEN,
    // 時間変更・ピン移動・標高参照などの通常UI操作でWorkers KVへ
    // DEMタイルを書き込まない。ブラウザ/サーバーメモリキャッシュを使用する。
    persistentCache: undefined,
    waitUntil: (promise) => context.waitUntil(promise),
  });
}
