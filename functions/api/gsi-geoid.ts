import { lookupGsiGeoidHeight } from "../../server/gsiGeoid.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request }) => {
  if (request.method !== "GET") {
    return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405, "public, max-age=86400");
  }
  const url = new URL(request.url);
  try {
    const geoidHeightMeters = await lookupGsiGeoidHeight(
      Number(url.searchParams.get("latitude")),
      Number(url.searchParams.get("longitude")),
      request.signal,
      url.searchParams.get("precision") === "point"
    );
    return jsonResponse({ geoidHeightMeters }, 200, "public, max-age=86400");
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=86400");
  }
};
