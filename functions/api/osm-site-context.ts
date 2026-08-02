import {
  lookupOsmSiteContexts,
  type OsmContextRequestPoint,
} from "../../server/osmSiteContext.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

function requestPoints(body: unknown): OsmContextRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body) || !Array.isArray(body.points)) {
    return null;
  }
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
    };
  });
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "public, max-age=300");
  }
  configureCloudflareServerRuntime(context);
  try {
    const body = await context.request.json() as unknown;
    const points = requestPoints(body);
    if (!points) {
      return jsonResponse({ error: "候補座標がありません" }, 400, "public, max-age=300");
    }
    const includeDetails = !(typeof body === "object" && body !== null &&
      "includeDetails" in body && body.includeDetails === false);
    const contexts = await lookupOsmSiteContexts(
      points,
      context.request.signal,
      includeDetails
    );
    return jsonResponse({
      contexts,
      attribution: "© OpenStreetMap contributors / 国土地理院 標高タイル",
    }, 200, "public, max-age=300");
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=300");
  }
};
