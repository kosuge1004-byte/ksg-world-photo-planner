// ランドマーク事前取得（プレウォーム）を、既存のPages Functionsアプリの
// 中で完結させるためのエンドポイント。
//
// メリット: 新しいWorkerもR2バケットも作らない。既存の /api/gsi-elevation
// などと同じ NETWORK_CACHE バインディングをそのまま再利用する
// （functions/_shared/env.ts で既に配線済み）。デプロイもGit連携の
// 通常のpushだけで完結する。
//
// 呼び出し方:
//   GET /api/prewarm-landmarks
//     → 今日の担当分（日付から自動選択、既定8件）を1回実行する
//   GET /api/prewarm-landmarks?count=3
//     → 件数を指定
//   GET /api/prewarm-landmarks?category=building
//     → カテゴリを絞る
//
// トリガーは無料の外部Cronサービス（例: cron-job.org）でこのURLを
// 1日1回叩くだけでよい。Cloudflare側の追加設定は不要。

import { configureCloudflareServerRuntime, type CloudflareEnv } from "../_shared/env.ts";
import { jsonResponse, errorMessage } from "../_shared/http.ts";
import { PREWARM_LANDMARKS, type PrewarmLandmark } from "../../server/landmarkPrewarmSeed.ts";
import { prewarmMany, selectDailyChunk } from "../../server/prewarmLandmarkCore.ts";

const DEFAULT_CHUNK_SIZE = 8;

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  configureCloudflareServerRuntime(context);

  const url = new URL(context.request.url);
  const category = url.searchParams.get("category") as PrewarmLandmark["category"] | null;
  const countParam = url.searchParams.get("count");
  const chunkSize = countParam ? Math.max(1, Number(countParam) || DEFAULT_CHUNK_SIZE) : DEFAULT_CHUNK_SIZE;

  let pool = PREWARM_LANDMARKS;
  if (category) pool = pool.filter((landmark) => landmark.category === category);

  const targets = selectDailyChunk(pool, chunkSize);
  const logs: string[] = [
    `対象: ${targets.length}件${category ? `（${category}のみ）` : ""} — ${targets.map((t) => t.name).join(", ")}`,
  ];

  try {
    const { totalAttempts, totalCandidates } = await prewarmMany(targets, (message) => logs.push(message));
    logs.push(`完了。合計試行 ${totalAttempts}回、候補 ${totalCandidates}件。`);
    return jsonResponse({ ok: true, targets: targets.map((t) => t.name), logs }, 200, "no-store");
  } catch (error) {
    logs.push(`エラー: ${errorMessage(error)}`);
    return jsonResponse({ ok: false, logs, error: errorMessage(error) }, 500, "no-store");
  }
};
