import {
  isDynamicSpotRegistrationInput,
} from "../../src/types/dynamicSpot.ts";
import {
  lookupLocalDynamicSpot,
  readLocalDynamicSpotStatus,
  registerLocalDynamicSpot,
  retryLocalDynamicSpot,
} from "../../server/localDemGateway.ts";
import { withCloudflareServerRuntime, type CloudflareEnv } from "./env.ts";
import { errorMessage, jsonResponse, readJsonRequest, requestErrorStatus } from "./http.ts";

export type DynamicSpotApiAction = "lookup" | "register" | "status" | "retry";
const MAX_REQUEST_BYTES = 32 * 1024;

function cors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function json(value: unknown, status = 200): Response {
  return cors(jsonResponse(value, status, "no-store"));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coordinateLookup(value: unknown): { latitude: number; longitude: number } | null {
  const body = record(value);
  if (!body || Object.keys(body).some((key) => key !== "latitude" && key !== "longitude")) return null;
  return typeof body.latitude === "number" && Number.isFinite(body.latitude) &&
    body.latitude >= 20 && body.latitude <= 46.5 &&
    typeof body.longitude === "number" && Number.isFinite(body.longitude) &&
    body.longitude >= 122 && body.longitude <= 154
    ? { latitude: body.latitude, longitude: body.longitude }
    : null;
}

export async function handleDynamicSpotApi(
  context: EventContext<CloudflareEnv, string, unknown>,
  action: DynamicSpotApiAction
): Promise<Response> {
  if (context.request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (context.request.method !== "POST") return json({ error: "POSTリクエストのみ利用できます" }, 405);
  return withCloudflareServerRuntime(context, async () => {
    try {
      const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
      if (action === "register") {
        if (!isDynamicSpotRegistrationInput(body)) return json({ error: "Dynamic Spot登録条件が不正です" }, 400);
        const spot = await registerLocalDynamicSpot(body, context.request.signal);
        return spot ? json({ spot }, 202) : json({ code: "LOCAL_DYNAMIC_SPOT_UNAVAILABLE", error: "PC/Eドライブへ接続できません。地点検索はそのまま利用できます。" }, 503);
      }
      if (action === "lookup") {
        const value = record(body);
        let spot = null;
        if (value && Object.keys(value).length === 1 && typeof value.query === "string" &&
          value.query.trim().length > 0 && value.query.length <= 200) {
          spot = await lookupLocalDynamicSpot({ query: value.query }, context.request.signal);
        } else {
          const coordinate = coordinateLookup(body);
          if (!coordinate) return json({ error: "Dynamic Spot検索条件が不正です" }, 400);
          spot = await lookupLocalDynamicSpot(coordinate, context.request.signal);
        }
        return spot ? json({ spot }) : json({ code: "DYNAMIC_SPOT_NOT_FOUND", error: "Dynamic Spotが見つかりません" }, 404);
      }
      const coordinate = coordinateLookup(body);
      if (!coordinate) return json({ error: "Dynamic Spot座標が不正です" }, 400);
      const spot = action === "status"
        ? await readLocalDynamicSpotStatus(coordinate.latitude, coordinate.longitude, context.request.signal)
        : await retryLocalDynamicSpot(coordinate.latitude, coordinate.longitude, context.request.signal);
      return spot
        ? json({ spot }, action === "retry" ? 202 : 200)
        : json({ code: "DYNAMIC_SPOT_NOT_FOUND", error: "Dynamic Spotが見つかりません" }, 404);
    } catch (error) {
      return json({ error: errorMessage(error) }, requestErrorStatus(error));
    }
  });
}

