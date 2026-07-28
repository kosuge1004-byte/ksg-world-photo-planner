import type { Config } from "@netlify/functions";

import { lookupGsiGeoidHeight } from "../../server/gsiGeoid.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const pointSpecific = url.searchParams.get("precision") === "point";
  try {
    const geoidHeightMeters = await lookupGsiGeoidHeight(
      latitude,
      longitude,
      request.signal,
      pointSpecific
    );
    return json({ geoidHeightMeters });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 422);
  }
}

export const config: Config = {
  path: "/api/gsi-geoid",
  method: "GET",
};
