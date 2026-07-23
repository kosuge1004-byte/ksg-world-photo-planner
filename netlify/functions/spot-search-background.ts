import type { Config } from "@netlify/functions";

import { runSpotSearchJob } from "../../server/runSpotSearchJob.ts";
import {
  getSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";

export default async function handler(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { clientId?: unknown; jobId?: unknown };
    if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId)) {
      throw new Error("検索ジョブIDが不正です");
    }
    const job = await getSpotSearchJob(body.clientId, body.jobId);
    if (!job) throw new Error("検索ジョブが見つかりません");
    if (job.status === "queued") await runSpotSearchJob(job);
    return new Response(JSON.stringify({ status: "accepted" }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 422,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

export const config: Config = {
  path: "/api/spot-search-background",
  method: "POST",
  background: true,
};
