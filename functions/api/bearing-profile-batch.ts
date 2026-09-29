import {
  isBearingProfileBatchRequest,
} from "../../server/bearingProfileBatch.ts";
import { findPrecomputedBearingProfileTarget } from "../../server/precomputedBearingProfileTargets.ts";
import {
  computeLocalBearingProfile,
  lookupLocalPrecomputedBearingProfile,
} from "../../server/localDemGateway.ts";
import { readR2PrecomputedBearingProfileCompressed } from "../../server/publishedPrecomputedBearingProfiles.ts";
import {
  withCloudflareServerRuntime,
  type CloudflareEnv,
} from "../_shared/env.ts";
import {
  errorMessage,
  jsonResponse,
  readJsonRequest,
  requestErrorStatus,
} from "../_shared/http.ts";

const MAX_REQUEST_BYTES = 256 * 1024;

function addCorsHeaders(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  return response;
}

function apiJson(
  value: unknown,
  status = 200,
  cacheControl?: string
): Response {
  return addCorsHeaders(jsonResponse(value, status, cacheControl));
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method === "OPTIONS") {
    return addCorsHeaders(new Response(null, { status: 204 }));
  }
  if (context.request.method !== "POST") {
    return apiJson({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  return withCloudflareServerRuntime(context, async () => {
    try {
      const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
      if (!isBearingProfileBatchRequest(body)) {
        return apiJson({ error: "全方位地形の取得条件が不正です" }, 400);
      }
      const compressed = await readR2PrecomputedBearingProfileCompressed(
        body,
        context.request.signal
      );
      if (compressed) {
        return new Response(compressed.bytes, {
          status: 200,
          // R2 already stores gzip bytes. "manual" prevents the Workers
          // runtime from applying a second gzip layer from this header.
          encodeBody: "manual",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept",
          },
        });
      }
      // A configured private E-drive remains an optional fallback. Its route
      // already returns a compact validated subset, so no gzip streaming is
      // involved here.
      const local = await lookupLocalPrecomputedBearingProfile(
        body,
        context.request.signal
      );
      if (local) return apiJson(local, 200, "no-store");

      // Last resort: calculate the exact requested origin at the private,
      // read-only E-drive service. This remains a single authenticated
      // Cloudflare subrequest and does not approximate from a neighbouring
      // registered spot. The origin enforces a 30 second deadline.
      const computed = await computeLocalBearingProfile(body, context.request.signal);
      if (computed) return apiJson(computed, 200, "no-store");

      // A live Pages invocation cannot calculate even one 10 km bearing: its
      // 352 exact DEM samples exceed the Worker subrequest allowance. Running
      // that known-broken path caused a 422 which the client silently hid, then
      // a roughly hour-long direct fallback. Registered spots must have their
      // already calculated R2 object, so report a concrete configuration error
      // immediately instead of showing 0/259 indefinitely.
      // 計算済みデータを公開済みの地点だけ。登録直後で未計算の地点は404で直接取得へ。
      const registered = findPrecomputedBearingProfileTarget(
        body.subjectPoint.latitude,
        body.subjectPoint.longitude
      );
      if (registered) {
        return apiJson({
          code: "PRECOMPUTED_PROFILE_UNAVAILABLE",
          error: "登録スポットの計算済み地形データがCloudflare R2に未配置、またはR2を読み出せません。",
        }, 503, "no-store");
      }
      // Arbitrary coordinates must not fall back to hundreds of device/GSI
      // requests. The E-drive origin is the final exact-data path; when it is
      // unavailable, return a prompt, retryable error.
      return apiJson({
        code: "LOCAL_DEM_PROFILE_UNAVAILABLE",
        error: "この地点の正確な地形データをEドライブで計算できません。PC・Eドライブ・Cloudflare Tunnelの状態を確認して再実行してください。",
      }, 503, "no-store");
    } catch (error) {
      return apiJson(
        { error: errorMessage(error) },
        requestErrorStatus(error),
        "no-store"
      );
    }
  });
};
