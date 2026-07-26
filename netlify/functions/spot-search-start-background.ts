import type { Config } from "@netlify/functions";

import type { SpotSearchJob } from "../../src/types/backgroundSearch.ts";
import {
  setSpotSearchJob,
  updateSpotSearchJob,
  validSearchJobId,
  validSpotSearchJobInput,
} from "../../server/spotSearchJobs.ts";
import { runSpotSearchJob } from "../../server/runSpotSearchJob.ts";

type StartRequest = {
  clientId?: unknown;
  jobId?: unknown;
  input?: unknown;
};

export default async function handler(request: Request): Promise<Response> {
  let activeJob: { clientId: string; jobId: string } | null = null;
  try {
    const body = await request.json() as StartRequest;
    if (
      !validSearchJobId(body.clientId) ||
      !validSearchJobId(body.jobId) ||
      !validSpotSearchJobInput(body.input)
    ) {
      throw new Error("バックグラウンド検索条件が不正です");
    }

    activeJob = { clientId: body.clientId, jobId: body.jobId };
    const now = new Date().toISOString();
    const job: SpotSearchJob = {
      version: 1,
      clientId: activeJob.clientId,
      jobId: activeJob.jobId,
      status: "queued",
      progress: "バックグラウンド検索を開始しています…",
      progressPercent: 0,
      input: body.input,
      results: [],
      createdAt: now,
      updatedAt: now,
    };

    // NetlifyがこのHandlerを直接Background Functionとして起動する。
    // 同一サイトへの自己fetchを挟まないことで、SPAフォールバックを成功応答と
    // 誤認してqueuedのまま残る経路を無くす。
    await setSpotSearchJob(job);
    await runSpotSearchJob(job);
  } catch (error) {
    if (activeJob) {
      try {
        await updateSpotSearchJob(activeJob.clientId, activeJob.jobId, {
          status: "failed",
          progress: "検索処理に失敗しました",
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Blob保存前の失敗では更新対象が無い。Netlifyの実行ログへ原因を残す。
      }
    }
    console.error("スポット検索Background Functionエラー", error);
  }

  // Background Functionの応答本文は破棄され、呼び出し元には先に202が返る。
  return new Response(null, { status: 202 });
}

export const config: Config = {
  path: "/api/spot-search-start",
  method: "POST",
  background: true,
};
