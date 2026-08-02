import { findCloudflareTimeZones } from "../../server/cloudflareGeoTz.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { jsonResponse } from "../_shared/http.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  if (request.method !== "GET") {
    return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405);
  }
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return jsonResponse({ error: "緯度・経度が不正です" }, 400, "public, max-age=86400");
  }
  try {
    const timeZone = (
      await findCloudflareTimeZones(latitude, longitude, env.ASSETS, request.url)
    )[0];
    return timeZone
      ? jsonResponse({ timeZone }, 200, "public, max-age=86400")
      : jsonResponse({ error: "タイムゾーンを特定できません" }, 404, "public, max-age=86400");
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 422, "public, max-age=86400");
  }
};
