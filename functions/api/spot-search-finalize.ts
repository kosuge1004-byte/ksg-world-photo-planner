import type { SerializedSpotPresetResult } from "../../src/types/backgroundSearch.ts";
import {
  updateSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";
import {
  spotSearchJobKv,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

function validResults(value: unknown): value is SerializedSpotPresetResult[] {
  return Array.isArray(value) && value.length <= 100 && value.every((result) =>
    typeof result === "object" && result !== null &&
    "id" in result && typeof result.id === "string" &&
    "date" in result && typeof result.date === "string"
  );
}

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const body = await request.json() as {
      clientId?: unknown;
      jobId?: unknown;
      results?: unknown;
    };
    if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId) ||
      !validResults(body.results)) {
      throw new Error("最終3D確認結果が不正です");
    }
    const job = await updateSpotSearchJob(
      spotSearchJobKv(env),
      body.clientId,
      body.jobId,
      {
        status: "complete",
        progress: "検索が完了しました",
        results: body.results,
        error: undefined,
      }
    );
    return jsonResponse(job);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
