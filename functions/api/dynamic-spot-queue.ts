/**
 * 2026-10-16: データサービスにつながらなかった間に貯めた自動登録スポットを、
 * データサービス（パソコン側）が受け取るための入口。一般の利用者は使えない。
 *
 * POST { action: "take", limit?: number }      → { items: [{ coordinateKey, queuedAt, input }] }
 * POST { action: "ack", coordinateKeys: [...] } → { removed: number }
 */
import {
  acknowledgeDynamicSpotRegistrations,
  takeDynamicSpotRegistrations,
} from "../../server/dynamicSpotPendingQueue.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse, readJsonRequest, requestErrorStatus } from "../_shared/http.ts";
import { isAuthorizedRegistrationRequest } from "../_shared/registrationAuth.ts";

const MAX_REQUEST_BYTES = 4 * 1024;

function response(value: unknown, status = 200): Response {
  const result = jsonResponse(value, status, "no-store");
  result.headers.set("X-Robots-Tag", "noindex, nofollow");
  return result;
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return response({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  if (!isAuthorizedRegistrationRequest(context.request, context.env.LOCAL_DEM_REGISTRATION_TOKEN)) {
    return response({ error: "認証できません" }, 401);
  }
  const db = context.env.R2_WRITE_BUDGET_DB;
  if (!db) return response({ error: "保管先が設定されていません", code: "QUEUE_UNAVAILABLE" }, 503);
  try {
    const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
    const value = typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    if (value.action === "take") {
      const limit = typeof value.limit === "number" ? value.limit : undefined;
      return response({ items: await takeDynamicSpotRegistrations(db, limit) });
    }
    if (value.action === "ack" && Array.isArray(value.coordinateKeys) &&
      value.coordinateKeys.every((key) => typeof key === "string")) {
      return response({
        removed: await acknowledgeDynamicSpotRegistrations(db, value.coordinateKeys as string[]),
      });
    }
    return response({ error: "要求が不正です" }, 400);
  } catch (error) {
    return response({ error: errorMessage(error) }, requestErrorStatus(error));
  }
};
