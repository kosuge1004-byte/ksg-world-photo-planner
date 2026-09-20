import {
  lookupOsmSiteContexts,
  type OsmContextRequestPoint,
  type SiteContextPurpose,
} from "../../server/osmSiteContext.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

// 通常の地理条件照合は小分けのままにする。water-onlyはサーバー側で地点数に
// 依存しない1個の包含円へ集約され、ダウンロード1件の2,590地点を一括処理する。
const MAX_POINTS_PER_REQUEST = 500;
const MAX_WATER_ONLY_POINTS_PER_REQUEST = 3_000;

function requestPoints(body: unknown): OsmContextRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body) || !Array.isArray(body.points)) {
    return null;
  }
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
    };
  });
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "no-store");
  }
  configureCloudflareServerRuntime(context);
  try {
    const body = await context.request.json() as unknown;
    const points = requestPoints(body);
    if (!points) {
      return jsonResponse({ error: "候補座標がありません" }, 400, "no-store");
    }
    const requestedPurpose =
      typeof body === "object" && body !== null && "purpose" in body
        ? body.purpose
        : undefined;
    const maximumPoints = requestedPurpose === "water-only"
      ? MAX_WATER_ONLY_POINTS_PER_REQUEST
      : MAX_POINTS_PER_REQUEST;
    if (points.length > maximumPoints) {
      return jsonResponse(
        { error: `候補座標は1リクエストあたり最大${maximumPoints}件までです` },
        400,
        "no-store"
      );
    }
    const includeDetails = !(typeof body === "object" && body !== null &&
      "includeDetails" in body && body.includeDetails === false);
    // 2026-09-05追記: purpose="height-only"の場合、access系（歩行可否・
    // 私有地・車道・水面判定用）のOverpass問い合わせを完全に省略し、
    // 構造物・建物の高さ情報だけを取得する（詳しい経緯はosmSiteContext.ts
    // 冒頭コメント参照）。三脚候補探索など、access判定が必要な既存の
    // 呼び出しには一切影響しない（未指定時は従来どおり"full"）。
    const purpose: SiteContextPurpose =
      requestedPurpose === "height-only" || requestedPurpose === "water-only"
        ? requestedPurpose
        : "full";
    const cacheKeyInput = {
      includeDetails,
      purpose,
      points: points.map((point) => ({
        latitude: Number(point.latitude.toFixed(5)),
        longitude: Number(point.longitude.toFixed(5)),
      })),
    };
    const result = await getOrCreateR2Json(context.env.NETWORK_CACHE, context.env.SPOT_SEARCH_JOBS, context.request, cacheKeyInput, {
      namespace: "osm-site-context", version: "v2", ttlSeconds: 7 * 86400,
    }, async () => ({
      contexts: await lookupOsmSiteContexts(points, context.request.signal, includeDetails, purpose),
      attribution: "© OpenStreetMap contributors / 国土地理院",
    }), context.waitUntil);
    return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=300");
  } catch (error) {
    // エラー応答は公開キャッシュしない（失敗を5分キャッシュして再試行を妨げない）。
    return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
  }
};
