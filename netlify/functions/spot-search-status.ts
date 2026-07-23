import type { Config } from "@netlify/functions";

import {
  getSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";

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
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const jobId = url.searchParams.get("jobId");
  if (!validSearchJobId(clientId) || !validSearchJobId(jobId)) {
    return jsonResponse({ error: "検索ジョブIDが不正です" }, 400);
  }
  try {
    const job = await getSpotSearchJob(clientId, jobId);
    return job
      ? jsonResponse(job)
      : jsonResponse({ error: "検索ジョブが見つかりません" }, 404);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
    }, 422);
  }
}

export const config: Config = {
  path: "/api/spot-search-status",
  method: "GET",
};
