const HIGH_PRECISION_SESSION_STORAGE_KEY = "astrosight-high-precision-session-v1";

type CachedHighPrecisionSession = {
  sessionId?: string;
  expiresAt?: number;
};

type HighPrecisionSessionResponse = {
  allowed?: boolean;
  sessionId?: string;
  sessionTtlSeconds?: number;
  count?: number;
  stopLimit?: number;
  reason?: string;
};

/**
 * Googleタイルモード（Google Photorealistic 3D Tiles）のセッション許可を取得する。
 *
 * localStorageにキャッシュしたsessionIdを使い回すことで、同一セッション内で
 * メイン3DマップとARカメラの両方から呼び出しても、サーバー側の月間利用件数
 * カウント（/api/high-precision-session）が二重に増えないようにする。
 * サーバー側は「同じsessionIdが既に記録されているか」でカウント要否を判定するため、
 * ここで生成・キャッシュしたIDを両方の呼び出し元で共有することが安全性の前提となる。
 *
 * 上限到達・ネットワークエラー等の場合はエラーをthrowする。呼び出し側で
 * キャッチしてフォールバック（標準モード表示等）すること。
 */
export async function authorizeHighPrecisionSession(): Promise<void> {
  const now = Date.now();
  let sessionId = "";
  try {
    const cached = JSON.parse(
      localStorage.getItem(HIGH_PRECISION_SESSION_STORAGE_KEY) ?? "null"
    ) as CachedHighPrecisionSession | null;
    if (cached?.sessionId && typeof cached.expiresAt === "number" && cached.expiresAt > now) {
      sessionId = cached.sessionId;
    }
  } catch {
    localStorage.removeItem(HIGH_PRECISION_SESSION_STORAGE_KEY);
  }
  if (!sessionId) {
    sessionId = crypto.randomUUID().replaceAll("-", "");
  }

  // サーバー応答がハングした場合に無期限で待ち続けないよう、タイムアウトを
  // 設ける（Googleタイルモードへの切替自体が固まって見える不具合の原因の
  // 1つだった）。
  const response = await fetch("/api/high-precision-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = (await response.json()) as HighPrecisionSessionResponse;
  if (!response.ok || !result.allowed) {
    // 2026-08-25追記: サーバー側（functions/api/high-precision-session.ts）は
    // 「本当に月間上限に達した場合」（reason: monthly_limit_reached）と、
    // 「KVの一時的な不調等で判定自体ができなかった場合」
    // （reason: usage_check_unavailable）を区別して返している。以前は
    // どちらも同じ「利用上限に達しました」という文言に丸めており、
    // 実際には一時的な不調なのに恒久的な上限到達のように見えてしまっていた。
    if (result.reason === "usage_check_unavailable") {
      throw new Error(
        "Googleタイルモードの利用可否を確認できませんでした（サーバー側の一時的な不調の可能性があります）。しばらくしてから再試行するか、標準モードをご利用ください。"
      );
    }
    throw new Error(
      `今月のGoogleタイルモード利用上限に達しました（${result.count ?? "-"}/${result.stopLimit ?? 850}）。標準モードをご利用ください。`
    );
  }

  localStorage.setItem(
    HIGH_PRECISION_SESSION_STORAGE_KEY,
    JSON.stringify({
      sessionId: result.sessionId ?? sessionId,
      expiresAt: now + (result.sessionTtlSeconds ?? 10800) * 1000,
    })
  );
}
