import { resolveJapanesePlaceName } from "../../server/placeGeocode.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request }) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as { query?: unknown };
    if (typeof body.query !== "string") {
      return jsonResponse({ error: "スポット名がありません" }, 400);
    }
    return jsonResponse(await resolveJapanesePlaceName(body.query, request.signal));
  } catch (error) {
    const message = errorMessage(error);
    return jsonResponse({ error: message }, message.includes("見つかりません") ? 404 : 422);
  }
};
