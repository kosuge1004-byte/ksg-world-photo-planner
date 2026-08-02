import {
  getSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";
import {
  spotSearchJobKv,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  if (request.method !== "GET") {
    return jsonResponse({ error: "GETリクエストのみ利用できます" }, 405);
  }
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const jobId = url.searchParams.get("jobId");
  if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
    return jsonResponse({ error: "検索ジョブIDが不正です" }, 400);
  }
  try {
    const job = await getSpotSearchJob(spotSearchJobKv(env), clientId, jobId);
    return job
      ? jsonResponse(job)
      : jsonResponse({ error: "検索ジョブが見つかりません" }, 404);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
