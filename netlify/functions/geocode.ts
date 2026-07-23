import type { Config } from "@netlify/functions";

import { resolveGoogleMapsSharedUrl } from "../../server/googleMaps.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POSTリクエストのみ利用できます" }, 405);
  }

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return jsonResponse({ error: "送信内容を読み取れませんでした" }, 400);
  }
  const sharedUrl =
    typeof requestBody === "object" &&
    requestBody !== null &&
    "url" in requestBody &&
    typeof requestBody.url === "string"
      ? requestBody.url
      : "";
  if (!sharedUrl.trim()) {
    return jsonResponse({ error: "Googleマップの共有URLを入力してください" }, 400);
  }

  try {
    return jsonResponse(await resolveGoogleMapsSharedUrl(sharedUrl));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `共有URLの解析に失敗しました：${message}` }, 422);
  }
}

export const config: Config = {
  path: "/api/resolve-google-maps",
  method: "POST",
};
