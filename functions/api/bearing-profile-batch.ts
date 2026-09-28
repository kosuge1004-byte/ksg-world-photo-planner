import {
  computeBearingProfileBatch,
  isBearingProfileBatchRequest,
} from "../../server/bearingProfileBatch.ts";
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

const MAX_REQUEST_BYTES = 256 * 1024;

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  return withCloudflareServerRuntime(context, async () => {
    try {
      const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
      if (!isBearingProfileBatchRequest(body)) {
        return jsonResponse({ error: "全方位地形の取得条件が不正です" }, 400);
      }
      const result = await computeBearingProfileBatch(body, context.request.signal);
      return jsonResponse(result, 200, "no-store");
    } catch (error) {
      return jsonResponse(
        { error: errorMessage(error) },
        requestErrorStatus(error),
        "no-store"
      );
    }
  });
};
