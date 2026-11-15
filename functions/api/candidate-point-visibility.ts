import { lookupLocalCandidatePointVisibility } from "../../server/localDemGateway.ts";
import { isCandidatePointVisibilityRequest } from "../../src/types/candidatePointVisibility.ts";
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

const MAX_REQUEST_BYTES = 64 * 1024;

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405, "no-store");
  }
  return withCloudflareServerRuntime(context, async () => {
    try {
      const body: unknown = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
      if (!isCandidatePointVisibilityRequest(body)) {
        return jsonResponse({ error: "見通し判定の入力が不正です" }, 400, "no-store");
      }
      const result = await lookupLocalCandidatePointVisibility(body, context.request.signal);
      if (!result) {
        return jsonResponse({ error: "建物データを確認できません" }, 503, "no-store");
      }
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
