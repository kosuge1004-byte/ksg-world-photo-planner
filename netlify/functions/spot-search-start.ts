import type { Config } from "@netlify/functions";

import type { SpotSearchJob } from "../../src/types/backgroundSearch.ts";
import {
  setSpotSearchJob,
  updateSpotSearchJob,
  validSearchJobId,
  validSpotSearchJobInput,
} from "../../server/spotSearchJobs.ts";

type StartRequest = {
  clientId?: unknown;
  jobId?: unknown;
  input?: unknown;
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }

  try {
    const body = await request.json() as StartRequest;
    if (
      !validSearchJobId(body.clientId) ||
      !validSearchJobId(body.jobId) ||
      !validSpotSearchJobInput(body.input)
    ) {
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

    // Background Function本体はクライアントへ先に202を返すため、そこで初めて
    // ジョブを保存するとstatus側が404になる。通常Functionで先に強整合保存する。
    await setSpotSearchJob(job);

    const workerUrl = new URL("/api/internal/spot-search-worker", request.url);
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: job.clientId,
        jobId: job.jobId,
      }),
    });
    if (!workerResponse.ok) {
      await updateSpotSearchJob(job.clientId, job.jobId, {
        status: "failed",
        progress: "検索処理を起動できませんでした",
        error: `検索ワーカー起動エラー：${workerResponse.status}`,
      });
      return jsonResponse({
        error: `検索ワーカー起動エラー：${workerResponse.status}`,
      }, 502);
    }

    return jsonResponse({ jobId: job.jobId, status: "queued" }, 202);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 422);
  }
}

export const config: Config = {
  path: "/api/spot-search-start",
  method: "POST",
};
