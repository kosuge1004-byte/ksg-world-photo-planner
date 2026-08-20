import {
  lookupOsmSiteContexts,
  type OsmContextRequestPoint,
} from "../../server/osmSiteContext.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

// クライアント側の実際の最大利用規模（Googleタイルモードの局所再探索候補は
// 最大49地点）に対して十分な余裕を持たせた上限。これを超える1リクエストは
// 通常の利用では発生せず、Overpass/DEM等への大量投入だけを弾く。
const MAX_POINTS_PER_REQUEST = 500;

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
    if (points.length > MAX_POINTS_PER_REQUEST) {
      return jsonResponse(
        { error: `候補座標は1リクエストあたり最大${MAX_POINTS_PER_REQUEST}件までです` },
        400,
        "no-store"
      );
    }
    const includeDetails = !(typeof body === "object" && body !== null &&
      "includeDetails" in body && body.includeDetails === false);
    const cacheKeyInput = {
      includeDetails,
      points: points.map((point) => ({
        latitude: Number(point.latitude.toFixed(5)),
        longitude: Number(point.longitude.toFixed(5)),
      })),
    };
    const result = await getOrCreateR2Json(context.env.NETWORK_CACHE, cacheKeyInput, {
      namespace: "osm-site-context", version: "v1", ttlSeconds: 7 * 86400,
    }, async () => ({
      contexts: await lookupOsmSiteContexts(points, context.request.signal, includeDetails),
      attribution: "© OpenStreetMap contributors / 国土地理院 標高タイル",
    }), context.waitUntil);
    return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=300");
  } catch (error) {
    // エラー応答は公開キャッシュしない（失敗を5分キャッシュして再試行を妨げない）。
    return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
  }
};
