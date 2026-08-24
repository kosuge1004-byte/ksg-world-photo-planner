// 主要ランドマークのDEMタイルキャッシュを手動で事前取得するCLIスクリプト。
// 定期実行版は workers/prewarm-landmark-cron.ts（Cloudflare Cron Trigger）。
//
// 使い方（例）:
//   npx tsx server/prewarmLandmarkCache.ts
//   npx tsx server/prewarmLandmarkCache.ts --category=mountain
//   npx tsx server/prewarmLandmarkCache.ts --start=10 --count=5

import { PREWARM_LANDMARKS, type PrewarmLandmark } from "./landmarkPrewarmSeed.ts";
import { prewarmMany } from "./prewarmLandmarkCore.ts";
import { configureServerRuntime } from "./cloudflareRuntime.ts";
import { persistentCacheFromR2 } from "./r2PersistentCache.ts";
import { getPlatformProxy } from "wrangler";

function parseArgs(): { category?: PrewarmLandmark["category"]; start: number; count: number } {
  const args = process.argv.slice(2);
  const get = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  return {
    category: get("category") as PrewarmLandmark["category"] | undefined,
    start: Number(get("start") ?? 0),
    count: Number(get("count") ?? Number.POSITIVE_INFINITY),
  };
}

async function main() {
  const { category, start, count } = parseArgs();
  let targets = PREWARM_LANDMARKS;
  if (category) targets = targets.filter((l) => l.category === category);
  targets = targets.slice(start, start + count);

  // Pages Functions/Workerと同じ実R2バケット（NETWORK_CACHE）に接続する。
  // wrangler.jsonc/toml（メインアプリのPages設定）にNETWORK_CACHEのR2
  // bindingが定義されている前提。無い場合はpersistentCacheがundefinedに
  // なり、書き込みは行われず従来どおり通信するだけになる（安全なフォール
  // バック）。
  const platform = await getPlatformProxy<{ NETWORK_CACHE?: R2Bucket }>();
  configureServerRuntime({
    persistentCache: undefined, // R2 safety: manual prewarm writes disabled
    waitUntil: (promise) => promise,
  });

  console.log(`対象ランドマーク: ${targets.length}件${category ? `（${category}のみ）` : ""}`);
  console.log(
    platform.env.NETWORK_CACHE
      ? "R2永続キャッシュ（NETWORK_CACHE）に接続しました。"
      : "⚠ NETWORK_CACHEのR2 bindingが見つかりません。DEMは取得しますがキャッシュへの書き込みは行われません。"
  );

  const { totalAttempts, totalCandidates } = await prewarmMany(targets, (message) => console.log(message));

  console.log(`完了。合計試行 ${totalAttempts}回、候補 ${totalCandidates}件。`);
  await platform.dispose();
}

main().catch((error) => {
  console.error("事前取得スクリプトが失敗しました:", error);
  process.exitCode = 1;
});
