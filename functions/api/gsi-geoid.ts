import { lookupGsiGeoidHeight } from "../../server/gsiGeoid.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

type GeoidPoint = { latitude: number; longitude: number };

function parseBatch(body: unknown): { points: GeoidPoint[]; pointSpecific: boolean } | null {
  if (typeof body !== "object" || body === null || !("points" in body) || !Array.isArray(body.points)) return null;
  if (body.points.length === 0 || body.points.length > 512) return null;
  const points = body.points.map((value) => {
    if (typeof value !== "object" || value === null) return { latitude: Number.NaN, longitude: Number.NaN };
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
    };
  });
  return {
    points,
    pointSpecific: "precision" in body && body.precision === "point",
  };
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  configureCloudflareServerRuntime(context);
  const { request } = context;
  if (request.method === "GET") {
    const url = new URL(request.url);
    try {
      const pointSpecific = url.searchParams.get("precision") === "point";
      const latitude = Number(url.searchParams.get("latitude"));
      const longitude = Number(url.searchParams.get("longitude"));
      const normalized = {
        latitude: Number(latitude.toFixed(pointSpecific ? 8 : 2)),
        longitude: Number(longitude.toFixed(pointSpecific ? 8 : 2)),
        pointSpecific,
      };
      const result = await getOrCreateR2Json(context.env.NETWORK_CACHE, normalized, {
        namespace: "gsi-geoid", version: "v1", ttlSeconds: 180 * 86400,
      }, async () => ({
        geoidHeightMeters: await lookupGsiGeoidHeight(latitude, longitude, request.signal, pointSpecific),
      }), context.waitUntil);
      return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=86400");
    } catch (error) {
      // エラー応答は公開キャッシュしない（失敗を24時間キャッシュして
      // 再試行を妨げないようにする）。
      return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
    }
  }
  if (request.method === "POST") {
    try {
      const parsed = parseBatch(await request.json());
      if (!parsed) return jsonResponse({ error: "座標配列が不正です" }, 400, "no-store");
      const decimals = parsed.pointSpecific ? 8 : 2;
      const normalized = parsed.points.map((point) => ({
        latitude: Number(point.latitude.toFixed(decimals)),
        longitude: Number(point.longitude.toFixed(decimals)),
      }));
      const result = await getOrCreateR2Json(context.env.NETWORK_CACHE, {
        points: normalized,
        pointSpecific: parsed.pointSpecific,
      }, {
        namespace: "gsi-geoid-batch", version: "v1", ttlSeconds: 180 * 86400,
      }, async () => ({
        geoidHeightMeters: await Promise.all(parsed.points.map((point) =>
          lookupGsiGeoidHeight(point.latitude, point.longitude, request.signal, parsed.pointSpecific)
        )),
      }), context.waitUntil);
      return jsonResponse({ ...result.value, cache: result.cache }, 200, "public, max-age=86400");
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
    }
  }
  return jsonResponse({ error: "GETまたはPOSTリクエストのみ利用できます" }, 405, "no-store");
};
