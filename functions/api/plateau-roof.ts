import { lookupLocalPlateauRoof } from "../../server/localDemGateway.ts";
import {
  withCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import {
  errorMessage,
  jsonResponse,
  readJsonRequest,
  requestErrorStatus,
} from "../_shared/http.ts";

const MAX_REQUEST_BYTES = 2_048;

function coordinate(body: unknown): { latitude: number; longitude: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "latitude" && key !== "longitude") ||
    typeof value.latitude !== "number" || !Number.isFinite(value.latitude) ||
    typeof value.longitude !== "number" || !Number.isFinite(value.longitude) ||
    value.latitude < 20 || value.latitude > 46.5 || value.longitude < 122 || value.longitude > 154) {
    return null;
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "no-store");
  }
  return withCloudflareServerRuntime(context, async () => {
    try {
      const point = coordinate(await readJsonRequest(context.request, MAX_REQUEST_BYTES));
      if (!point) return jsonResponse({ error: "座標が不正です" }, 400, "no-store");
      const candidate = await lookupLocalPlateauRoof(
        point.latitude,
        point.longitude,
        context.request.signal
      );
      return jsonResponse({ candidate }, 200, "no-store");
    } catch (error) {
      return jsonResponse(
        { error: errorMessage(error) },
        requestErrorStatus(error),
        "no-store"
      );
    }
  });
};
