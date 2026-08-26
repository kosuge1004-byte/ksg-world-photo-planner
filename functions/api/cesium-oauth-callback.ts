import { jsonResponse, errorMessage } from "../_shared/http.ts";

/**
 * Cesium ion OAuth 2.0（PKCE方式）のトークン交換を仲介する。
 *
 * PKCE方式のためクライアントシークレットは不要（Cesium ion公式ドキュメント
 * https://cesium.com/learn/ion/ion-oauth2/ でも token exchange リクエストに
 * client_secret パラメータは含まれない）。それでもこの処理をサーバー側で
 * 一段挟んでいるのは、Cesium ionのトークンエンドポイント
 * （api.cesium.com）がブラウザからの直接fetchを許可するCORS設定を
 * 提供しているか確認できていないため、フロントエンドから直接叩けない
 * 場合の保険としての中継である。
 *
 * ここで得たアクセストークン・リフレッシュトークンは、このサーバーには
 * 一切保存しない（AstroSightはユーザーアカウントを持たない設計のため）。
 * レスポンスとしてそのままクライアントへ返し、クライアント側
 * （src/precision/cesiumIonConnection.ts）が端末内にのみ保存する。
 */

const CESIUM_ION_CLIENT_ID = "2235";
const CESIUM_ION_REDIRECT_URI = "https://astrosight.pages.dev/api/cesium-oauth-callback";
const CESIUM_ION_TOKEN_ENDPOINT = "https://api.cesium.com/oauth/token";
const REQUEST_TIMEOUT_MS = 10_000;

type TokenExchangeRequestBody =
  | { grantType: "authorization_code"; code: string; codeVerifier: string }
  | { grantType: "refresh_token"; refreshToken: string };

type CesiumIonTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
};

function parseRequestBody(body: unknown): TokenExchangeRequestBody | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.grantType === "authorization_code") {
    if (typeof candidate.code !== "string" || typeof candidate.codeVerifier !== "string") return null;
    return { grantType: "authorization_code", code: candidate.code, codeVerifier: candidate.codeVerifier };
  }
  if (candidate.grantType === "refresh_token") {
    if (typeof candidate.refreshToken !== "string") return null;
    return { grantType: "refresh_token", refreshToken: candidate.refreshToken };
  }
  return null;
}

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context;
  const parsed = parseRequestBody(await request.json().catch(() => null));
  if (!parsed) {
    return jsonResponse({ error: "リクエストの形式が不正です" }, 400, "no-store");
  }

  const params = new URLSearchParams({
    client_id: CESIUM_ION_CLIENT_ID,
    redirect_uri: CESIUM_ION_REDIRECT_URI,
  });
  if (parsed.grantType === "authorization_code") {
    params.set("grant_type", "authorization_code");
    params.set("code", parsed.code);
    params.set("code_verifier", parsed.codeVerifier);
  } else {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", parsed.refreshToken);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CESIUM_ION_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Cesium ion側のエラー詳細をそのまま転記せず、要点だけ返す
      // （アクセストークン等の機微な情報が含まれないことを確認できないため）。
      return jsonResponse(
        { error: `Cesium ionとの接続に失敗しました（HTTP ${response.status}）` },
        422,
        "no-store"
      );
    }
    const data = await response.json() as CesiumIonTokenResponse;
    const now = Date.now();
    return jsonResponse({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessTokenExpiresAtMs: now + data.expires_in * 1000,
      refreshTokenExpiresAtMs: now + data.refresh_token_expires_in * 1000,
    });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 422, "no-store");
  } finally {
    clearTimeout(timeout);
  }
};
