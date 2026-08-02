import type { SpotSearchJob } from "../../src/types/backgroundSearch.ts";
import {
  createSpotSearchJobUpdater,
  setSpotSearchJob,
  validSearchJobId,
  validSpotSearchJobInput,
} from "../../server/spotSearchJobs.ts";
import {
  spotSearchJobKv,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

type StartRequest = {
  clientId?: unknown;
  jobId?: unknown;
  input?: unknown;
};

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as StartRequest;
    if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId) ||
      !validSpotSearchJobInput(body.input)) {
      return jsonResponse({ error: "バックグラウンド検索条件が不正です" }, 400);
    }
    const now = new Date().toISOString();
    const job: SpotSearchJob = {
      version: 1,
      clientId: body.clientId,
      jobId: body.jobId,
      status: "queued",
      progress: "バックグラウンド検索を開始しています…",
      progressPercent: 0,
      input: body.input,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    const kv = spotSearchJobKv(env);
    await setSpotSearchJob(kv, job);
    try {
      await env.SPOT_SEARCH_QUEUE.send({ version: 1, job });
    } catch (error) {
      const updateJob = createSpotSearchJobUpdater(kv, job);
      await updateJob(job.clientId, job.jobId, {
        status: "failed",
        progress: "検索処理を起動できませんでした",
        error: errorMessage(error),
      });
      return jsonResponse({ error: errorMessage(error) }, 502);
    }
    return jsonResponse({ jobId: job.jobId, status: "queued" }, 202);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
