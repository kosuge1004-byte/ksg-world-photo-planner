// 主要ランドマークのDEMタイルキャッシュを定期的に温めるCloudflare Worker。
// wrangler.jsonc のCron Triggerから起動される。
//
// 197件（今後増える見込み）を一度に処理すると1回の実行が長くなりすぎる
// ため、server/prewarmLandmarkCore.ts の selectDailyChunk() で
// 「今日の担当分」だけを処理し、日をまたいで全件を自動的に巡回する。
// 状態はどこにも保存しない（Workers KVへの書き込みを増やさない方針）。

import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "../server/r2PersistentCache.ts";
import { PREWARM_LANDMARKS } from "../server/landmarkPrewarmSeed.ts";
import { prewarmMany, selectDailyChunk } from "../server/prewarmLandmarkCore.ts";

// 1回の実行あたりの処理件数。1件あたり最大12回のDEM検索
// （REQUEST_DELAY_MS=1.5秒間隔）+ ランドマーク間4秒待機のため、
// 8件でおおよそ数分程度に収まる想定（Cron Triggerの実行時間に配慮）。
const CHUNK_SIZE = 8;

interface PrewarmEnv {
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  NETWORK_CACHE?: R2Bucket;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: PrewarmEnv,
    context: ExecutionContext
  ): Promise<void> {
    configureServerRuntime({
      cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
      persistentCache: persistentCacheFromR2(env.NETWORK_CACHE),
      waitUntil: (promise) => context.waitUntil(promise),
    });

    const targets = selectDailyChunk(PREWARM_LANDMARKS, CHUNK_SIZE);
    console.log(`[prewarm-cron] 本日の担当分: ${targets.length}件 (${targets.map((t) => t.name).join(", ")})`);

    const { totalAttempts, totalCandidates } = await prewarmMany(targets, (message) =>
      console.log(`[prewarm-cron] ${message}`)
    );

    console.log(`[prewarm-cron] 完了。合計試行 ${totalAttempts}回、候補 ${totalCandidates}件。`);
  },

  // Cron Trigger専用のWorkerだが、手動での動作確認用にHTTPからも
  // トリガーできるようにしておく（ブラウザ/curlでアクセスして即時実行）。
  async fetch(
    _request: Request,
    env: PrewarmEnv,
    context: ExecutionContext
  ): Promise<Response> {
    configureServerRuntime({
      cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
      persistentCache: persistentCacheFromR2(env.NETWORK_CACHE),
      waitUntil: (promise) => context.waitUntil(promise),
    });

    const targets = selectDailyChunk(PREWARM_LANDMARKS, CHUNK_SIZE);
    const logs: string[] = [`本日の担当分: ${targets.length}件 (${targets.map((t) => t.name).join(", ")})`];

    const { totalAttempts, totalCandidates } = await prewarmMany(targets, (message) => logs.push(message));

    logs.push(`完了。合計試行 ${totalAttempts}回、候補 ${totalCandidates}件。`);
    return new Response(logs.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
