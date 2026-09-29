import {
  isBearingProfileBatchRequest,
} from "../../server/bearingProfileBatch.ts";
import { PRECOMPUTED_BEARING_PROFILE_TARGETS } from "../../server/precomputedBearingProfileTargets.ts";
import { lookupLocalPrecomputedBearingProfile } from "../../server/localDemGateway.ts";
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

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  return withCloudflareServerRuntime(context, async () => {
    try {
      const body = await readJsonRequest(context.request, MAX_REQUEST_BYTES);
      if (!isBearingProfileBatchRequest(body)) {
        return jsonResponse({ error: "全方位地形の取得条件が不正です" }, 400);
      }
      const compressed = await readR2PrecomputedBearingProfileCompressed(
        body,
        context.request.signal
      );
      if (compressed) {
        return new Response(compressed.bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Encoding": "gzip",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
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
      if (local) return jsonResponse(local, 200, "no-store");

      // A live Pages invocation cannot calculate even one 10 km bearing: its
      // 352 exact DEM samples exceed the Worker subrequest allowance. Running
      // that known-broken path caused a 422 which the client silently hid, then
      // a roughly hour-long direct fallback. Registered spots must have their
      // already calculated R2 object, so report a concrete configuration error
      // immediately instead of showing 0/259 indefinitely.
      // 計算済みデータを公開済みの地点だけ。登録直後で未計算の地点は404で直接取得へ。
      const registered = PRECOMPUTED_BEARING_PROFILE_TARGETS.some((landmark) =>
        Math.abs(landmark.latitude - body.subjectPoint.latitude) <= 0.0000001 &&
        Math.abs(landmark.longitude - body.subjectPoint.longitude) <= 0.0000001
      );
      if (registered) {
        return jsonResponse({
          code: "PRECOMPUTED_PROFILE_UNAVAILABLE",
          error: "登録スポットの計算済み地形データがCloudflare R2に未配置、またはR2を読み出せません。",
        }, 503, "no-store");
      }
      // Arbitrary coordinates retain the exact client-side path. A 404 is an
      // intentional capability miss, not a failed calculation.
      return jsonResponse({
        code: "PRECOMPUTED_PROFILE_NOT_FOUND",
        error: "この地点には計算済み地形データがありません。",
      }, 404, "no-store");
    } catch (error) {
      return jsonResponse(
        { error: errorMessage(error) },
        requestErrorStatus(error),
        "no-store"
      );
    }
  });
};
