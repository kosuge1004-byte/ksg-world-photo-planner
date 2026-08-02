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
    persistentCache: context.env.SPOT_SEARCH_JOBS,
    waitUntil: (promise) => context.waitUntil(promise),
  });
}
