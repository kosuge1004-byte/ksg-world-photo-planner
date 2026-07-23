import type { Config } from "@netlify/functions";
import { find } from "geo-tz";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export default function handler(request: Request): Response {
  if (request.method !== "GET") {
    return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405);
  }
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const valid =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  if (!valid) return jsonResponse({ error: "緯度・経度が不正です" }, 400);

  // geo-tzの境界ポリゴンで撮影地点のIANAタイムゾーンを決める。
  const timeZones = find(latitude, longitude);
  const timeZone = timeZones[0];
  if (!timeZone) return jsonResponse({ error: "タイムゾーンを特定できません" }, 404);
  return jsonResponse({ timeZone });
}

export const config: Config = {
  path: "/api/timezone",
  method: "GET",
};
