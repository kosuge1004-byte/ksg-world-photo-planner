import {
  lookupGsiElevations,
  type GsiElevationRequestPoint,
} from "../../server/gsiElevation.ts";
import {
  configureCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

function requestPoints(body: unknown): GsiElevationRequestPoint[] | null {
  if (typeof body !== "object" || body === null || !("points" in body)) return null;
  if (!Array.isArray(body.points)) return null;
  return body.points.map((value) => {
    if (typeof value !== "object" || value === null) {
      return { latitude: Number.NaN, longitude: Number.NaN };
    }
    return {
      latitude: "latitude" in value ? Number(value.latitude) : Number.NaN,
      longitude: "longitude" in value ? Number(value.longitude) : Number.NaN,
      maximumDetail: "maximumDetail" in value &&
        (value.maximumDetail === "1m" || value.maximumDetail === "5m" || value.maximumDetail === "10m")
        ? value.maximumDetail
        : undefined,
    };
  });
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "public, max-age=3600");
  }
  configureCloudflareServerRuntime(context);
  try {
    const points = requestPoints(await context.request.json());
    if (!points) {
      return jsonResponse({ error: "座標の配列がありません" }, 400, "public, max-age=3600");
    }
    return jsonResponse(
      { samples: await lookupGsiElevations(points, context.request.signal) },
      200,
      "public, max-age=3600"
    );
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422, "public, max-age=3600");
  }
};
