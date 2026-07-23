import type { Config } from "@netlify/functions";

import { lookupOsmSiteContexts } from "../../server/osmSiteContext.ts";
import type { OsmContextRequestPoint } from "../../server/osmSiteContext.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function requestPoints(body: unknown): OsmContextRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body)) return null;
  if (!Array.isArray(body.points)) return null;
  return body.points.map((point) => {
    if (typeof point !== "object" || point === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in point ? Number(point.latitude) : Number.NaN,
      longitude: "longitude" in point ? Number(point.longitude) : Number.NaN,
    };
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as unknown;
    const points = requestPoints(body);
    if (!points) return jsonResponse({ error: "候補座標がありません" }, 400);
    const includeDetails = !(
      typeof body === "object" && body !== null &&
      "includeDetails" in body && body.includeDetails === false
    );
    const contexts = await lookupOsmSiteContexts(
      points,
      request.signal,
      includeDetails
    );
    return jsonResponse({
      contexts,
      attribution: "© OpenStreetMap contributors / 国土地理院 標高タイル",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 422);
  }
}

export const config: Config = {
  path: "/api/osm-site-context",
  method: "POST",
};
