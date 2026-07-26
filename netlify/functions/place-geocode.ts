import type { Config } from "@netlify/functions";

import { resolveJapanesePlaceName } from "../../server/placeGeocode.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as { query?: unknown };
    if (typeof body.query !== "string") {
      return jsonResponse({ error: "スポット名がありません" }, 400);
    }
    return jsonResponse(
      await resolveJapanesePlaceName(body.query, request.signal)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("見つかりません") ? 404 : 422;
    return jsonResponse({ error: message }, status);
  }
}

export const config: Config = {
  path: "/api/geocode",
  method: "POST",
};
