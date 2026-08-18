import {
  GoogleMapsResolutionError,
  resolveGoogleMapsSharedUrl,
} from "../../server/googleMaps.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `google-maps-${Date.now().toString(36)}`;
  }
}

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request, env }) => {
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
    return jsonResponse(await resolveGoogleMapsSharedUrl(sharedUrl, {
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
      requestId: currentRequestId,
    }));
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
