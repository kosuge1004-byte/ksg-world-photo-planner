import type { Config } from "@netlify/functions";

import {
  lookupGsiElevations,
} from "../../server/gsiElevation.ts";
import type {
  GsiElevationRequestPoint,
} from "../../server/gsiElevation.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function requestPoints(body: unknown): GsiElevationRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body)) {
    return null;
  }
  const points = body.points;
  if (!Array.isArray(points)) return null;
  return points.map((point) => {
    if (typeof point !== "object" || point === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in point ? Number(point.latitude) : Number.NaN,
      longitude: "longitude" in point ? Number(point.longitude) : Number.NaN,
      maximumDetail:
        "maximumDetail" in point &&
        (point.maximumDetail === "1m" ||
          point.maximumDetail === "5m" ||
          point.maximumDetail === "10m")
          ? point.maximumDetail
          : undefined,
    };
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const points = requestPoints(await request.json());
    if (!points) return jsonResponse({ error: "座標配列がありません" }, 400);
    return jsonResponse({ samples: await lookupGsiElevations(points, request.signal) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 422);
  }
}

export const config: Config = {
  path: "/api/gsi-elevation",
  method: "POST",
};
