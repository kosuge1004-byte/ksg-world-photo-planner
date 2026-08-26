/**
 * ユーザー自身のCesium ionアカウントへOAuth 2.0で接続する（BYOA方式）。
 *
 * これまでは開発者1人のCesium ionトークン（VITE_CESIUM_ION_TOKEN）を
 * 全ユーザーで共有していたため、利用量がすべて開発者のアカウントに
 * 計上され、Cesium社への問い合わせでも「各ユーザーが自分のアカウントを
 * 使う（Bring Your Own Account）」構成が前提として案内されていた。
 *
 * ここでは、その構成を実現するため:
 *   1) ユーザーをCesium ionの認証画面へ送り、
 *   2) 認証コードをサーバー側（/api/cesium-oauth-callback）でアクセス
 *      トークンへ交換し、
 *   3) 得られたトークンを端末内（localStorage）にのみ保存する
 * という流れを扱う。サーバー側にユーザーアカウントを持たない設計との
 * 兼ね合いで、トークンはあえて端末内保存のみとし、他端末とは同期しない。
 */

const STORAGE_KEY = "ksg-cesium-ion-connection";
const PKCE_VERIFIER_STORAGE_KEY = "ksg-cesium-ion-pkce-verifier";
const OAUTH_STATE_STORAGE_KEY = "ksg-cesium-ion-oauth-state";

// Cesium ion側で発行されたアプリケーション情報（公開情報。秘密鍵ではない）。
const CESIUM_ION_CLIENT_ID = "2235";
const CESIUM_ION_REDIRECT_URI = "https://astrosight.pages.dev/api/cesium-oauth-callback";
// Google Photorealistic 3D Tilesの読み込みに必要な最小権限のみ要求する。
const CESIUM_ION_SCOPES = "assets:read assets:list";

export type CesiumIonConnection = {
  accessToken: string;
  refreshToken: string;
  /** アクセストークンの有効期限（UNIX時刻ミリ秒）。 */
  accessTokenExpiresAtMs: number;
  /** リフレッシュトークンの有効期限（UNIX時刻ミリ秒）。 */
  refreshTokenExpiresAtMs: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Cesium ionの認証画面へ遷移するためのURLを組み立て、PKCE検証用の値を
 * 端末内に一時保存する。呼び出し側は、得られたURLへ実際に遷移させること
 * （location.href = url など）。
 */
export async function beginCesiumIonConnection(): Promise<string> {
  const codeVerifier = randomString(64);
  const state = randomString(24);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));

  sessionStorage.setItem(PKCE_VERIFIER_STORAGE_KEY, codeVerifier);
  sessionStorage.setItem(OAUTH_STATE_STORAGE_KEY, state);

  const url = new URL("https://ion.cesium.com/oauth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CESIUM_ION_CLIENT_ID);
  url.searchParams.set("redirect_uri", CESIUM_ION_REDIRECT_URI);
  url.searchParams.set("scope", CESIUM_ION_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * リダイレクト後のURL（?code=...&state=...）を受け取り、サーバー側の
 * トークン交換エンドポイントへ橋渡しして接続を完了させる。
 * 呼び出し側は、成功後にリダイレクト用のクエリパラメータをURLから
 * 消すこと（履歴を汚さないため）。
 */
export async function completeCesiumIonConnection(
  code: string,
  state: string
): Promise<CesiumIonConnection> {
  const expectedState = sessionStorage.getItem(OAUTH_STATE_STORAGE_KEY);
  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_STORAGE_KEY);
  sessionStorage.removeItem(OAUTH_STATE_STORAGE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_STORAGE_KEY);

  if (!expectedState || state !== expectedState) {
    throw new Error("認証状態を確認できませんでした（state不一致）。もう一度接続をお試しください。");
  }
  if (!codeVerifier) {
    throw new Error("認証情報の有効期限が切れました。もう一度接続をお試しください。");
  }

  const response = await fetch("/api/cesium-oauth-callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grantType: "authorization_code", code, codeVerifier }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Cesium ionとの接続に失敗しました");
  }
  const connection = (await response.json()) as CesiumIonConnection;
  saveCesiumIonConnection(connection);
  return connection;
}

export function loadCesiumIonConnection(): CesiumIonConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CesiumIonConnection>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.accessTokenExpiresAtMs !== "number" ||
      typeof parsed.refreshTokenExpiresAtMs !== "number"
    ) {
      return null;
    }
    return parsed as CesiumIonConnection;
  } catch {
    return null;
  }
}

function saveCesiumIonConnection(connection: CesiumIonConnection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
}

export function disconnectCesiumIon(): void {
  localStorage.removeItem(STORAGE_KEY);
}

const ACCESS_TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // 期限の1日前から更新を試みる

/**
 * 有効なアクセストークンを返す。期限が近い場合は自動的に更新する。
 * 未接続、またはリフレッシュトークンも失効している場合はnullを返す
 * （呼び出し側は標準モードへフォールバックすること）。
 */
export async function getValidCesiumIonAccessToken(): Promise<string | null> {
  const connection = loadCesiumIonConnection();
  if (!connection) return null;

  const now = Date.now();
  if (now < connection.accessTokenExpiresAtMs - ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return connection.accessToken;
  }
  if (now >= connection.refreshTokenExpiresAtMs) {
    // リフレッシュトークンも失効。再接続が必要なため、古い接続情報は破棄する。
    disconnectCesiumIon();
    return null;
  }

  try {
    const response = await fetch("/api/cesium-oauth-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantType: "refresh_token", refreshToken: connection.refreshToken }),
    });
    if (!response.ok) {
      // 更新に失敗した場合、まだ期限内であれば古いトークンを使い続けさせる
      // （即座に接続断とはせず、次回に再試行する余地を残す）。
      return now < connection.accessTokenExpiresAtMs ? connection.accessToken : null;
    }
    const refreshed = (await response.json()) as CesiumIonConnection;
    saveCesiumIonConnection(refreshed);
    return refreshed.accessToken;
  } catch {
    return now < connection.accessTokenExpiresAtMs ? connection.accessToken : null;
  }
}

export function isCesiumIonConnected(): boolean {
  return loadCesiumIonConnection() !== null;
}

// 2026-08-26追記: 「1つのCesium ionアカウントの利用が、複数端末で使い
// 回されていないか」を検知する目的で導入。ただしAstroSightはユーザー
// アカウントを持たない設計のため、サーバー側で複数端末を横断して
// 名寄せする手段がない。そのため、この端末単体での利用回数のみを
// 数える（=複数端末で使い回された場合、それぞれの端末は無自覚に低い
// カウントのままになる）。この limitation はユーザーに正直に案内し
// （「これは端末ごとのカウントであり、複数端末で同じアカウントを使う
// 場合は合算で無料枠を超える可能性がある」）、実際の判断はユーザー
// 自身の申告・注意に委ねる設計とする。
const USAGE_COUNT_STORAGE_KEY = "ksg-cesium-ion-usage-count";
const USAGE_SESSION_STORAGE_KEY = "ksg-cesium-ion-usage-session";
const USAGE_SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3時間: 同一セッション内の再利用は1回として数える
export const CESIUM_ION_USAGE_WARNING_THRESHOLD = 500;

type UsageRecord = { month: string; count: number };

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function loadUsageRecord(): UsageRecord {
  try {
    const raw = localStorage.getItem(USAGE_COUNT_STORAGE_KEY);
    if (!raw) return { month: currentMonthKey(), count: 0 };
    const parsed = JSON.parse(raw) as Partial<UsageRecord>;
    if (typeof parsed.month !== "string" || typeof parsed.count !== "number") {
      return { month: currentMonthKey(), count: 0 };
    }
    // 月が変わっていたらリセットする。
    if (parsed.month !== currentMonthKey()) return { month: currentMonthKey(), count: 0 };
    return parsed as UsageRecord;
  } catch {
    return { month: currentMonthKey(), count: 0 };
  }
}

/**
 * 高精度モード（Googleタイルモード）を1回利用するたびに呼び出す。
 * 同一セッション（3時間）内の重複呼び出しはカウントしない。
 * 戻り値は「この端末での今月の利用回数」。
 */
export function recordCesiumIonHighPrecisionUsage(): number {
  const now = Date.now();
  const lastSessionAt = Number(sessionStorage.getItem(USAGE_SESSION_STORAGE_KEY) ?? "0");
  const record = loadUsageRecord();
  if (Number.isFinite(lastSessionAt) && now - lastSessionAt < USAGE_SESSION_TTL_MS) {
    return record.count;
  }
  sessionStorage.setItem(USAGE_SESSION_STORAGE_KEY, String(now));
  const updated: UsageRecord = { month: currentMonthKey(), count: record.count + 1 };
  localStorage.setItem(USAGE_COUNT_STORAGE_KEY, JSON.stringify(updated));
  return updated.count;
}

export function getCesiumIonMonthlyUsageCount(): number {
  return loadUsageRecord().count;
}
