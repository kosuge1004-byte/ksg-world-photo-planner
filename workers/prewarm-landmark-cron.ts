// 主要ランドマークのDEMタイルキャッシュを定期的に温めるCloudflare Worker。
// wrangler.prewarm.jsonc のCron Triggerから起動される。
//
// 197件（今後増える見込み）を一度に処理すると1回の実行が長くなりすぎる
// ため、server/prewarmLandmarkCore.ts の selectDailyChunk() で
// 「今日の担当分」だけを処理し、日をまたいで全件を自動的に巡回する。
//
// R2への保存は server/r2SafetyBudget.ts の予算ガード（月間書き込み/読み取り
// 上限・1回あたりの上限・保存容量上限）経由でのみ行う。SPOT_SEARCH_JOBS KVが
// 未設定/取得できない場合はfail-closedでR2書き込みをスキップする
// （persistentCacheFromR2がsafetyKv未提供時に内部でallowされない設計）。

import { configureServerRuntime } from "../server/cloudflareRuntime.ts";
import { PREWARM_LANDMARKS } from "../server/landmarkPrewarmSeed.ts";
import { prewarmMany, selectDailyChunk } from "../server/prewarmLandmarkCore.ts";
import { persistentCacheFromR2 } from "../server/r2PersistentCache.ts";
import type { R2SafetyKv } from "../server/r2SafetyBudget.ts";
import { lookupOsmSiteContexts } from "../server/osmSiteContext.ts";

// 1回の実行あたりの処理件数。
//
// Cloudflare公式の制限（developers.cloudflare.com/workers/platform/limits）:
//   - CPU時間: 有料プランで30秒/回（実際に計算している時間のみ。
//     fetch()やsleep()などの待機時間はカウントされない）
//   - 実時間（wall-clock time）: Cron Triggerは15分/回まで
// このワーカーの処理時間は、大半がGSIサーバーへの配慮のための意図的な
// 待機（REQUEST_DELAY_MS=1.5秒×最大12回/件、LANDMARK_DELAY_MS=4秒/件）と
// 通信待ちで占められ、実際のCPU時間はごくわずかなため、支配的な制約は
// 「15分の実時間上限」の方。
// 1件あたり最大12回のDEM検索（1.5秒間隔）+ ランドマーク間4秒待機のため、
// 1件あたり約22秒。35件で約12.8分となり、15分の上限に対して安全マージン
// （約2分）を残しつつ、以前の8件（約35日で全件一巡）より大幅に速く
// （約8日で一巡）できる件数として35件を設定する。
const CHUNK_SIZE = 35;

interface PrewarmEnv {
  CESIUM_ION_TOKEN?: string;
  VITE_CESIUM_ION_TOKEN?: string;
  NETWORK_CACHE?: R2Bucket;
  SPOT_SEARCH_JOBS?: R2SafetyKv;
}

const PUBLIC_APP_ORIGINS = new Set([
  "https://astrosight.pages.dev",
]);

function waterApiHeaders(origin: string | null): HeadersInit {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin && PUBLIC_APP_ORIGINS.has(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {}),
  };
}

async function handleWaterApi(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !PUBLIC_APP_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: "許可されていない送信元です" }), {
      status: 403,
      headers: waterApiHeaders(null),
    });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...waterApiHeaders(origin),
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POSTリクエストのみ利用できます" }), {
      status: 405,
      headers: waterApiHeaders(origin),
    });
  }
  try {
    const body = await request.json() as { points?: unknown };
    if (!Array.isArray(body.points) || body.points.length < 1 || body.points.length > 3_000) {
      throw new Error("候補座標は1〜3000件で指定してください");
    }
    const points = body.points.map((value) => {
      if (typeof value !== "object" || value === null) {
        return { latitude: Number.NaN, longitude: Number.NaN };
      }
      return {
        latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
        longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
      };
    });
    const contexts = await lookupOsmSiteContexts(
      points,
      request.signal,
      false,
      "water-only"
    );
    return new Response(JSON.stringify({ contexts }), {
      status: 200,
      headers: waterApiHeaders(origin),
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 422,
      headers: waterApiHeaders(origin),
    });
  }
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: PrewarmEnv,
    context: ExecutionContext
  ): Promise<void> {
    if (!env.NETWORK_CACHE) {
      // R2バインディングが無いと、この実行はDEMを取得するだけで
      // キャッシュへ何も保存できず、先読みの効果がゼロになる
      // （B-17）。実際のR2バケット作成はこのWorkerからはできないため、
      // せめて「今日は無効な状態で実行された」ことをログへ明示する。
      console.warn(
        "[prewarm-cron] NETWORK_CACHE（R2）が未設定のため、今回の実行はキャッシュへ保存されません。" +
          "wrangler.prewarm.jsoncのr2_bucketsを有効化してください。"
      );
    }
    if (!env.SPOT_SEARCH_JOBS) {
      console.warn(
        "[prewarm-cron] SPOT_SEARCH_JOBS（予算カウンター用KV）が未設定のため、" +
          "安全のためR2への保存はスキップされます。wrangler.prewarm.jsoncのkv_namespacesを確認してください。"
      );
    }
    configureServerRuntime({
      cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
      persistentCache: persistentCacheFromR2(env.NETWORK_CACHE, env.SPOT_SEARCH_JOBS, event),
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
    request: Request,
    env: PrewarmEnv,
    context: ExecutionContext
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/api/osm-water") {
      return handleWaterApi(request);
    }
    configureServerRuntime({
      cesiumIonToken: env.CESIUM_ION_TOKEN ?? env.VITE_CESIUM_ION_TOKEN,
      persistentCache: persistentCacheFromR2(env.NETWORK_CACHE, env.SPOT_SEARCH_JOBS, request),
      waitUntil: (promise) => context.waitUntil(promise),
    });

    const targets = selectDailyChunk(PREWARM_LANDMARKS, CHUNK_SIZE);
    const logs: string[] = [`本日の担当分: ${targets.length}件 (${targets.map((t) => t.name).join(", ")})`];
    if (!env.NETWORK_CACHE) {
      logs.push(
        "警告: NETWORK_CACHE（R2）が未設定のため、今回の実行はキャッシュへ保存されません。" +
          "wrangler.prewarm.jsoncのr2_bucketsを有効化してください。"
      );
    }
    if (!env.SPOT_SEARCH_JOBS) {
      logs.push("警告: SPOT_SEARCH_JOBS（予算カウンター用KV）が未設定のため、安全のためR2への保存はスキップされます。");
    }

    const { totalAttempts, totalCandidates } = await prewarmMany(targets, (message) => logs.push(message));

    logs.push(`完了。合計試行 ${totalAttempts}回、候補 ${totalCandidates}件。`);
    return new Response(logs.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
