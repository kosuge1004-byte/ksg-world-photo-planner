import {
  GoogleMapsResolutionError,
  resolveGoogleMapsSharedUrl,
} from "../../server/googleMaps.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";
import { getOrCreateR2Json } from "../_shared/r2Cache.ts";

function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `google-maps-${Date.now().toString(36)}`;
  }
}

export const onRequest: PagesFunction<CloudflareEnv> = async (context) => {
  const { request, env } = context;
  const currentRequestId = requestId();
  if (request.method !== "POST") {
    return jsonResponse({
      error: "POSTリクエストのみ利用できます",
      code: "METHOD_NOT_ALLOWED",
      requestId: currentRequestId,
      details: { method: request.method },
    }, 405);
  }
  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch (error) {
    return jsonResponse({
      error: "送信内容を読み取れませんでした",
      code: "INVALID_JSON",
      requestId: currentRequestId,
      details: { message: errorMessage(error) },
    }, 400);
  }
  const sharedUrl = typeof requestBody === "object" && requestBody !== null &&
    "url" in requestBody && typeof requestBody.url === "string"
    ? requestBody.url
    : "";
  if (!sharedUrl.trim()) {
    return jsonResponse({
      error: "Googleマップの共有URLを入力してください",
      code: "URL_REQUIRED",
      requestId: currentRequestId,
      details: { receivedType: typeof sharedUrl },
    }, 400);
  }
  try {
    // 2026-08-29追記: 「429を再試行で乗り切る」だけでは、同じ共有URLを
    // 何度もGoogleへ問い合わせるたびに毎回レート制限のリスクへさらされる
    // ことになる。一度解決できた共有URLの座標はほぼ恒久的に変わらないため
    // （地図上の地点は動かない）、/api/geocodeと同じR2永続キャッシュへ
    // 結果を保存し、同一URLの2回目以降（同じ利用者の再試行、または別の
    // 利用者が同じ共有リンクを開いた場合を含む）はGoogleへ全くアクセス
    // せずキャッシュから即答することで、そもそもGoogleへ到達するリクエスト
        // 数自体を減らし、429が発生する機会そのものを減らす。
    const normalizedUrl = sharedUrl.trim();
    const result = await getOrCreateR2Json(
      env.NETWORK_CACHE,
      env.SPOT_SEARCH_JOBS,
      request,
      { url: normalizedUrl },
      { namespace: "resolve-google-maps", version: "v1", ttlSeconds: 30 * 86400 },
      () => resolveGoogleMapsSharedUrl(normalizedUrl, {
        googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
        requestId: currentRequestId,
      }),
      context.waitUntil
    );
    return jsonResponse({ ...result.value, cache: result.cache });
  } catch (error) {
    const resolutionError = error instanceof GoogleMapsResolutionError
      ? error
      : null;
    const payload = {
      error: `共有URLの解析に失敗しました：${errorMessage(error)}`,
      code: resolutionError?.code ?? "UNEXPECTED_RESOLVER_ERROR",
      requestId: currentRequestId,
      details: resolutionError?.diagnostics ?? {
        message: errorMessage(error),
      },
    };
    console.error("[resolve-google-maps]", JSON.stringify(payload));
    return jsonResponse(
      payload,
      422
    );
  }
};
