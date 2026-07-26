import type { Config } from "@netlify/functions";

import {
  getSpotSearchJob,
  updateSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";
import { runSpotSearchJob } from "../../server/runSpotSearchJob.ts";

export default async function handler(request: Request): Promise<Response> {
  let activeJob: { clientId: string; jobId: string } | null = null;
  try {
    const body = await request.json() as {
      clientId?: unknown;
      jobId?: unknown;
    };
    if (
      !validSearchJobId(body.clientId) ||
      !validSearchJobId(body.jobId)
    ) {
      throw new Error("検索ジョブIDが不正です");
    }
    activeJob = { clientId: body.clientId, jobId: body.jobId };

    // 開始APIが強整合で保存済みのジョブだけを処理し、入力の二重管理を避ける。
    const job = await getSpotSearchJob(activeJob.clientId, activeJob.jobId);
    if (!job) throw new Error("検索ジョブが見つかりません");
    await runSpotSearchJob(job);
  } catch (error) {
    try {
      if (activeJob) {
        await updateSpotSearchJob(activeJob.clientId, activeJob.jobId, {
          status: "failed",
          progress: "検索処理に失敗しました",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch {
      // ジョブID自体が読めない場合は更新対象が無いため、実行ログへだけ残す。
    }
    console.error("スポット検索ワーカーエラー", error);
  }

  // Background Functionでは応答本文は破棄される。
  return new Response(null, { status: 202 });
}

export const config: Config = {
  path: "/api/internal/spot-search-worker",
  method: "POST",
  background: true,
};
