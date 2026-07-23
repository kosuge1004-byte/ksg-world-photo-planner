import type { Config } from "@netlify/functions";

import type { SerializedSpotPresetResult } from "../../src/types/backgroundSearch.ts";
import {
  updateSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";

function validResults(value: unknown): value is SerializedSpotPresetResult[] {
  return Array.isArray(value) && value.length <= 100 && value.every((result) =>
    typeof result === "object" && result !== null &&
    "id" in result && typeof result.id === "string" &&
    "date" in result && typeof result.date === "string"
  );
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }
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
    const job = await updateSpotSearchJob(body.clientId, body.jobId, {
      status: "complete",
      progress: "検索が完了しました",
      results: body.results,
      error: undefined,
    });
    return new Response(JSON.stringify(job), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
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
  path: "/api/spot-search-finalize",
  method: "POST",
};
