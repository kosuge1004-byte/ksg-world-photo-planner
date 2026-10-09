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
  readEdriveProfileWriteBack,
  scheduleEdriveProfileWriteBack,
} from "../../server/edriveProfileWriteBack.ts";
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

/** 検証済みのJSON（文字列またはR2のバイト列）を再解析せずに返す。 */
function rawJsonResponse(body: string | ArrayBuffer): Response {
  return addCorsHeaders(new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  }));
}

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
      const registered = findPrecomputedBearingProfileTarget(
        body.subjectPoint.latitude,
        body.subjectPoint.longitude
      );
      // 2026-09-30: 取得順 R2（公開済み計算ファイル） → R2（Eドライブ計算結果の
      // 書き戻し） → Eドライブ（計算済み） → Eドライブ（その座標を計算）。
      // 書き戻しは登録スポット以外だけ（登録スポットは公開済みファイルが正）。
      if (!registered) {
        const writtenBack = await readEdriveProfileWriteBack(body);
        if (writtenBack) return rawJsonResponse(writtenBack);
      }
      const fromEdrive = await lookupLocalPrecomputedBearingProfile(
        body,
        context.request.signal
      ) ?? await computeLocalBearingProfile(body, context.request.signal);
      if (fromEdrive) {
        const jsonText = JSON.stringify(fromEdrive);
        if (!registered) scheduleEdriveProfileWriteBack(body, fromEdrive, jsonText);
        return rawJsonResponse(jsonText);
      }

      // A live Pages invocation cannot calculate even one 10 km bearing: its
      // 352 exact DEM samples exceed the Worker subrequest allowance. Running
      // that known-broken path caused a 422 which the client silently hid, then
      // a roughly hour-long direct fallback. Registered spots must have their
      // already calculated R2 object, so report a concrete configuration error
      // immediately instead of showing 0/259 indefinitely.
      // 計算済みデータを公開済みの地点だけ。登録直後で未計算の地点は404で直接取得へ。
      if (registered) {
        return apiJson({
          code: "PRECOMPUTED_PROFILE_UNAVAILABLE",
          error: "この内蔵スポットの計算済み地形データを取得できませんでした。",
        }, 503, "no-store");
      }
      // Arbitrary coordinates must not fall back to hundreds of device/GSI
      // requests. The E-drive origin is the final exact-data path; when it is
      // unavailable, return a prompt, retryable error.
      return apiJson({
        code: "PROFILE_SOURCE_UNAVAILABLE",
        error: "この地点の地形データをまとめて取得できなかったため、1方位ずつ取得します（時間がかかります）。",
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
