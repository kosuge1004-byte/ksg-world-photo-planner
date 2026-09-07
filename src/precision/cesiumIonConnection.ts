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
const PKCE_SAVED_AT_STORAGE_KEY = "ksg-cesium-ion-pkce-saved-at";
// PKCE検証情報の有効期間。この時間を過ぎたものは古い試行の残骸として無視する。
const PKCE_MAX_AGE_MS = 15 * 60 * 1000;

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
 *
 * 2026-09-01追記: iPhoneで「接続できない」という報告を受けて調査した結果、
 * PKCE検証値の保存にsessionStorageを使っていたことが原因と判明した。
 * iOSでは、ホーム画面に追加したスタンドアロン表示のアプリから外部ドメイン
 * （ion.cesium.com）へ遷移すると、その遷移がSafari側の別コンテキストで
 * 開かれることがあり、sessionStorageはそのブラウジングコンテキスト
 * （タブ/ウィンドウのインスタンス）に紐づくため、Safari側からは
 * スタンドアロンアプリ側で保存した値を参照できず認証が失敗していた。
 * localStorageは同一オリジンであればコンテキストをまたいで共有される
 * ため、こちらへ切り替える。有効期間（PKCE_MAX_AGE_MS）を併せて持たせ、
 * 古い試行の値が無期限に残り続けないようにする。
 */
export async function beginCesiumIonConnection(): Promise<string> {
  const codeVerifier = randomString(64);
  const state = randomString(24);
  const codeChallenge = base64UrlEncode(await sha256(codeVerifier));

  localStorage.setItem(PKCE_VERIFIER_STORAGE_KEY, codeVerifier);
  localStorage.setItem(OAUTH_STATE_STORAGE_KEY, state);
  localStorage.setItem(PKCE_SAVED_AT_STORAGE_KEY, String(Date.now()));

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
  const expectedState = localStorage.getItem(OAUTH_STATE_STORAGE_KEY);
  const codeVerifier = localStorage.getItem(PKCE_VERIFIER_STORAGE_KEY);
  const savedAt = Number(localStorage.getItem(PKCE_SAVED_AT_STORAGE_KEY) ?? "0");
  localStorage.removeItem(OAUTH_STATE_STORAGE_KEY);
  localStorage.removeItem(PKCE_VERIFIER_STORAGE_KEY);
  localStorage.removeItem(PKCE_SAVED_AT_STORAGE_KEY);

  if (!Number.isFinite(savedAt) || Date.now() - savedAt > PKCE_MAX_AGE_MS) {
    throw new Error("認証情報の有効期限が切れました。もう一度接続をお試しください。");
  }
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

// 2026-09-07修正: Cesium ion Community の Google Photorealistic 3D Tiles は
// 「1,000 root tiles / month」。Google Map Tiles API も Photorealistic 3D Tiles の
// quota 単位を root tileset query としており、1つの root から発行された timed session
// による renderer-originating tile requests（パン・ズーム・移動で読む子タイル）は別扱い。
// そのため従来の「3時間以内は1回」という端末独自セッションカウントを廃止し、
// createGooglePhotorealistic3DTileset() を新規に開始する直前の各試行を1回として数える。
//
// 注意: Cesium ion は Usage 値をアプリから取得する公開APIを提供していないため、これは
// 公式Usageそのものではなく「AstroSightが発生させようとしたroot取得」の端末内ミラー。
// createGooglePhotorealistic3DTileset() の全呼び出しを共通ローダーに集約し、再試行も
// 各1回として数えることで、公式のroot-request単位に可能な限り一致させる。
// 複数端末で同じCesium ionアカウントを使った場合、他端末分はこの端末では把握できない。
const USAGE_COUNT_STORAGE_KEY = "ksg-cesium-ion-usage-count";
export const CESIUM_ION_USAGE_WARNING_THRESHOLD = 500;
export const CESIUM_ION_USAGE_STOP_THRESHOLD = 800;

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
    // Cesium ion quotaと同じく暦月単位で管理する。端末のローカル暦月が変わった
    // 最初の参照時に0へ戻す。旧方式で同じキーに保存済みの当月値は安全側の
    // 下限値としてそのまま引き継ぎ、更新によって突然0へ戻ることを避ける。
    if (parsed.month !== currentMonthKey()) return { month: currentMonthKey(), count: 0 };
    return { month: parsed.month, count: Math.max(0, Math.floor(parsed.count)) };
  } catch {
    return { month: currentMonthKey(), count: 0 };
  }
}

export class CesiumIonRootTileLimitError extends Error {
  readonly count: number;

  constructor(count: number) {
    super(
      `Google 3Dマップの今月の安全利用上限（${CESIUM_ION_USAGE_STOP_THRESHOLD}回）に達したため、新しいGoogleタイルの取得を停止しました。翌月に自動的に利用可能になります。`
    );
    this.name = "CesiumIonRootTileLimitError";
    this.count = count;
  }
}

/**
 * Google Photorealistic 3D Tiles の新しい root tileset 取得を開始する直前に、
 * 必ず1回だけ呼ぶ。800回に既に到達している場合はカウントせず遮断する。
 * 800回目そのものは許可し、その後の新規root取得を禁止する。
 *
 * この関数を「Googleモードを開いた時」など上位UIから呼んではいけない。
 * 実際の createGooglePhotorealistic3DTileset() 呼び出し直前だけを計測点とする。
 */
function saveUsageRecord(record: UsageRecord): void {
  // カウンターを保存できない状態でGoogle root requestだけを進めると、
  // Cesium公式UsageよりAstroSightが少なくなる危険がある。そのため保存不能時は
  // root requestを開始しない（安全側に停止）。
  localStorage.setItem(USAGE_COUNT_STORAGE_KEY, JSON.stringify(record));
}

export function startCesiumIonRootTilesetRequest<T>(startRequest: () => T): { request: T; count: number } {
  const record = loadUsageRecord();
  if (record.count >= CESIUM_ION_USAGE_STOP_THRESHOLD) {
    throw new CesiumIonRootTileLimitError(record.count);
  }

  const updated: UsageRecord = {
    month: currentMonthKey(),
    count: record.count + 1,
  };

  // 先に1回分を予約保存し、その後にroot requestを開始する。
  // これによりlocalStorage保存失敗時に公式側だけ増える「過少カウント」を防ぐ。
  // startRequestが同期的に失敗した場合だけ、root request未開始と判断して予約を戻す。
  saveUsageRecord(updated);
  try {
    const request = startRequest();
    return { request, count: updated.count };
  } catch (error) {
    try {
      saveUsageRecord(record);
    } catch {
      // rollback保存まで失敗した場合は、安全側に過大カウントを残す。
    }
    throw error;
  }
}

export function getCesiumIonMonthlyUsageCount(): number {
  return loadUsageRecord().count;
}

export function setCesiumIonMonthlyUsageCountFromOfficialUsage(count: number): number {
  if (!Number.isFinite(count)) throw new Error("Cesium ion Usageの値が数値ではありません");
  const normalized = Math.max(0, Math.floor(count));
  saveUsageRecord({ month: currentMonthKey(), count: normalized });
  return normalized;
}

export function isCesiumIonRootTilesetRequestAllowed(): boolean {
  return loadUsageRecord().count < CESIUM_ION_USAGE_STOP_THRESHOLD;
}

