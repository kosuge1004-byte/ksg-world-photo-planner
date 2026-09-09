import type { BearingProfileDownloadJob } from "../../src/types/backgroundBearingProfile.ts";
import {
  getBearingProfileDownloadJob,
  setBearingProfileDownloadJob,
  validBearingJobId,
  validBearingProfileDownloadJobInput,
} from "../../server/bearingProfileDownloadJobs.ts";
import {
  bearingProfileDownloadJobKv,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

type StartRequest = {
  clientId?: unknown;
  jobId?: unknown;
  input?: unknown;
};

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  const requestId = request.headers.get("cf-ray") ??
    request.headers.get("x-request-id") ??
    crypto.randomUUID();
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  try {
    const body = await request.json() as StartRequest;
    if (!validBearingJobId(body.clientId) || !validBearingJobId(body.jobId) ||
      !validBearingProfileDownloadJobInput(body.input)) {
      return jsonResponse({ error: "ダウンロード条件が不正です" }, 400);
    }
    const kv = bearingProfileDownloadJobKv(env);
    if (!kv) {
      return jsonResponse({ error: "サーバー側ダウンロード機能は未設定です（BEARING_PROFILE_DOWNLOAD_JOBSが未束縛）" }, 503);
    }
    const existing = await getBearingProfileDownloadJob(kv, body.clientId, body.jobId);
    if (existing) {
      return jsonResponse(
        { jobId: existing.jobId, status: existing.status },
        existing.status === "complete" || existing.status === "failed" ? 200 : 202
      );
    }

    const now = new Date().toISOString();
    const job: BearingProfileDownloadJob = {
      version: 1,
      clientId: body.clientId,
      jobId: body.jobId,
      status: "queued",
      progress: "ダウンロードを開始しています…",
      progressPercent: 0,
      input: body.input,
      profiles: [],
      waterSiteContextPoints: [],
      waterSiteContexts: [],
      fullSiteContextPoints: [],
      fullSiteContexts: [],
      createdAt: now,
      updatedAt: now,
    };
    await setBearingProfileDownloadJob(kv, job, { source: "api/bearing-profile-download-start", requestId });
    try {
      await env.BEARING_PROFILE_DOWNLOAD_QUEUE?.send({ version: 1, job }) ??
        (() => { throw new Error("BEARING_PROFILE_DOWNLOAD_QUEUEが未束縛です"); })();
    } catch (error) {
      await setBearingProfileDownloadJob(kv, {
        ...job,
        status: "failed",
        progress: "ダウンロード処理を起動できませんでした",
        error: errorMessage(error),
        updatedAt: new Date().toISOString(),
      }, { source: "api/bearing-profile-download-start:queue-send-failed", requestId });
      return jsonResponse({ error: errorMessage(error) }, 502);
    }
    return jsonResponse({ jobId: job.jobId, status: "queued" }, 202);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
