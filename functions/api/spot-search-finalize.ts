import type { SerializedSpotPresetResult } from "../../src/types/backgroundSearch.ts";
import {
  getSpotSearchJob,
  validSearchJobId,
} from "../../server/spotSearchJobs.ts";
import {
  spotSearchJobKv,
  type CloudflareEnv,
} from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

function validResults(value: unknown): value is SerializedSpotPresetResult[] {
  return Array.isArray(value) && value.length <= 100 && value.every((result) =>
    typeof result === "object" && result !== null &&
    "id" in result && typeof result.id === "string" &&
    "date" in result && typeof result.date === "string"
  );
}

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
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
    const storedJob = await getSpotSearchJob(
      spotSearchJobKv(env),
      body.clientId,
      body.jobId
    );
    if (!storedJob) {
      return jsonResponse({ error: "検索ジョブが見つかりません" }, 404);
    }
    if (storedJob.status === "failed") {
      return jsonResponse({ error: storedJob.error ?? "検索に失敗しています" }, 409);
    }
    if (storedJob.status !== "awaiting-3d" && storedJob.status !== "complete") {
      return jsonResponse({ error: "最終3D確認を受け付けられる状態ではありません" }, 409);
    }

    // 最終3D確認結果は呼び出し元ですでに保持されており、
    // Active Jobもこの応答成功後に端末側で解除される。
    // Workers KVへcompleteを再保存すると、検索1回ごとに必ず1 PUT増えるため、
    // awaiting-3dの復旧用レコードを維持したまま完了応答だけを返す。
    // 同じfinalize要求の再送もPUT 0回で冪等に成功する。
    return jsonResponse({
      ...storedJob,
      status: "complete",
      progress: "検索が完了しました",
      progressPercent: 100,
      results: body.results,
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422);
  }
};
