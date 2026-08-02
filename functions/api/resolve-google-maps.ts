import { resolveGoogleMapsSharedUrl } from "../../server/googleMaps.ts";
import type { CloudflareEnv } from "../_shared/env.ts";
import { errorMessage, jsonResponse } from "../_shared/http.ts";

export const onRequest: PagesFunction<CloudflareEnv> = async ({ request }) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }
  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return jsonResponse({ error: "送信内容を読み取れませんでした" }, 400);
  }
  const sharedUrl = typeof requestBody === "object" && requestBody !== null &&
    "url" in requestBody && typeof requestBody.url === "string"
    ? requestBody.url
    : "";
  if (!sharedUrl.trim()) {
    return jsonResponse({ error: "Googleマップの共有URLを入力してください" }, 400);
  }
  try {
    return jsonResponse(await resolveGoogleMapsSharedUrl(sharedUrl));
  } catch (error) {
    return jsonResponse(
      { error: `共有URLの解析に失敗しました：${errorMessage(error)}` },
      422
    );
  }
};
