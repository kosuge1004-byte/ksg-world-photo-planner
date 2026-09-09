import {
  getBearingProfileDownloadJob,
  validBearingJobId,
} from "../../server/bearingProfileDownloadJobs.ts";
import {
  bearingProfileDownloadJobKv,
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
  if (!validBearingJobId(clientId) || !validBearingJobId(jobId)) {
    return jsonResponse({ error: "ダウンロードジョブIDが不正です" }, 400);
  }
  try {
    const kv = bearingProfileDownloadJobKv(env);
    if (!kv) {
      return jsonResponse({ error: "サーバー側ダウンロード機能は未設定です（BEARING_PROFILE_DOWNLOAD_JOBSが未束縛）" }, 503);
    }
    const job = await getBearingProfileDownloadJob(kv, clientId, jobId);
    return job ? jsonResponse(job) : jsonResponse({ error: "ダウンロードジョブが見つかりません" }, 404);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
