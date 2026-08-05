import { resolveJapanesePlaceName } from "../../server/placeGeocode.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  const { request, env } = context;
  if (request.method !== "POST") return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  try {
    const body = await request.json() as { query?: unknown };
    if (typeof body.query !== "string") return jsonResponse({ error: "スポット名がありません" }, 400);
    const query = body.query.trim().replace(/\s+/g, " ");
    const result = await getOrCreateR2Json(env.NETWORK_CACHE, { query }, {
      namespace: "geocode", version: "v1", ttlSeconds: 30 * 86400,
    }, () => resolveJapanesePlaceName(query, request.signal), context.waitUntil);
    return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=86400");
  } catch (error) {
    const message = errorMessage(error);
    return jsonResponse({ error: message }, message.includes("見つかりません") ? 404 : 422);
  }
};
