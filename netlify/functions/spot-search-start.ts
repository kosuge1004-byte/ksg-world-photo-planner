import type { Config } from "@netlify/functions";

import type { SpotSearchJob, SpotSearchJobInput } from "../../src/types/backgroundSearch.ts";
import {
  setSpotSearchJob,
  validSearchJobId,
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

function validInput(value: unknown): value is SpotSearchJobInput {
  if (typeof value !== "object" || value === null) return false;
  if (!("criteria" in value) || typeof value.criteria !== "object" || value.criteria === null) {
    return false;
  }
  if (!("subject" in value) || typeof value.subject !== "object" || value.subject === null) {
    return false;
  }
  return "baseDateIso" in value && typeof value.baseDateIso === "string" &&
    Number.isFinite(Date.parse(value.baseDateIso)) &&
    "timeZone" in value && typeof value.timeZone === "string" && value.timeZone.length <= 80 &&
    "lensCenterHeightMeters" in value && Number.isFinite(value.lensCenterHeightMeters) &&
    "subjectGroundHeightMeters" in value && Number.isFinite(value.subjectGroundHeightMeters) &&
    "calculationMode" in value &&
      (value.calculationMode === "standard" || value.calculationMode === "pro");
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as StartRequest;
    if (!validSearchJobId(body.clientId) || !validSearchJobId(body.jobId) ||
      !validInput(body.input)) {
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
    await setSpotSearchJob(job);

    const backgroundUrl = new URL("/api/spot-search-background", request.url);
    const response = await fetch(backgroundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientId: body.clientId, jobId: body.jobId }),
    });
    if (!response.ok) {
      throw new Error(`バックグラウンド処理を起動できません：${response.status}`);
    }
    return jsonResponse({ jobId: body.jobId, status: "queued" }, 202);
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
