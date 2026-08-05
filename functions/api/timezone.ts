import { findCloudflareTimeZones } from "../../server/cloudflareGeoTz.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  const { request, env } = context;
  if (request.method !== "GET") return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405);
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return jsonResponse({ error: "緯度・経度が不正です" }, 400, "public, max-age=86400");
  }
  try {
    const input = { latitude: Number(latitude.toFixed(4)), longitude: Number(longitude.toFixed(4)) };
    const result = await getOrCreateR2Json(env.NETWORK_CACHE, input, {
      namespace: "timezone", version: "v1", ttlSeconds: 30 * 86400,
    }, async () => ({ timeZone: (await findCloudflareTimeZones(latitude, longitude, env.ASSETS, request.url))[0] ?? null }), context.waitUntil);
    return result.value.timeZone
      ? jsonResponse({ timeZone: result.value.timeZone, cache: result.cache }, 200, "public, max-age=86400")
      : jsonResponse({ error: "タイムゾーンを特定できません", cache: result.cache }, 404, "public, max-age=86400");
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 422, "public, max-age=86400");
  }
};
