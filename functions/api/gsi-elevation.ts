import {
  lookupGsiElevations,
  createTileCacheCounter,
  type GsiElevationRequestPoint,
} from "../../server/gsiElevation.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

// クライアント側の実際の最大利用規模（地形稜線の粗走査1方位あたり最大112点、
// 複数天体を同時判定してもマイクロタスク単位でまとめて数百点程度）に対して
// 十分な余裕を持たせた上限。これを超える1リクエストは通常の利用では発生
// せず、大量投入による負荷（CPU・外部通信・R2キャッシュ）だけを弾く。
const MAX_POINTS_PER_REQUEST = 2000;

function requestPoints(body: unknown): GsiElevationRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body)) return null;
  if (!Array.isArray(body.points)) return null;
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
      maximumDetail: "maximumDetail" in value &&
        (value.maximumDetail === "1m" || value.maximumDetail === "5m" || value.maximumDetail === "10m")
        ? value.maximumDetail
        : undefined,
      interpolationMode: "interpolationMode" in value && value.interpolationMode === "neutral"
        ? "neutral"
        : "los-safe",
    };
  });
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "no-store");
  }
  configureCloudflareServerRuntime(context);
  try {
    const points = requestPoints(await context.request.json());
    if (!points) {
      return jsonResponse({ error: "座標の配列がありません" }, 400, "no-store");
    }
    if (points.length > MAX_POINTS_PER_REQUEST) {
      return jsonResponse(
        { error: `座標は1リクエストあたり最大${MAX_POINTS_PER_REQUEST}件までです` },
        400,
        "no-store"
      );
    }
    // 2026-08-28追記: 以前はここで「最大64点分の応答をまるごと1つの
    // 塊としてR2にキャッシュする」外側のバッチキャッシュ層
    // (getOrCreateR2Json)を経由していた。しかし三脚探索は毎回わずかに
    // 違う座標の組み合わせで問い合わせるため、この「複数点まとめて
    // 1キー」という単位はほとんどヒットせず、ミスするたびに応答全体を
    // 無駄にもう一度R2へ書き込んでいた（本当に効果があるのは、
    // server/gsiElevation.ts内部のDEMタイル単位のキャッシュの方）。
    // 外側の層を撤去し、常にlookupGsiElevationsを直接呼ぶことで、
    // 無駄な二重書き込みと、無意味なR2予算の消費をなくす。
    const tileCacheCounter = createTileCacheCounter();
    const samples = await lookupGsiElevations(points, context.request.signal, tileCacheCounter);
    return jsonResponse(
      {
        samples,
        tileCacheHit: tileCacheCounter.hit,
        tileCacheMiss: tileCacheCounter.miss,
        tileMemoryHit: tileCacheCounter.memoryHit,
        tileCacheShared: tileCacheCounter.shared,
        tileCacheBypass: tileCacheCounter.bypass,
      },
      200,
      "public, max-age=86400"
    );
  } catch (error) {
    // エラー応答は公開キャッシュしない（失敗を1時間キャッシュして再試行を妨げない）。
    return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
  }
};
