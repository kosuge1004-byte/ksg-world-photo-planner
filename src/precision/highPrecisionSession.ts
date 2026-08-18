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
};

/**
 * 高精度モード（Google Photorealistic 3D Tiles）のセッション許可を取得する。
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

  const response = await fetch("/api/high-precision-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const result = (await response.json()) as HighPrecisionSessionResponse;
  if (!response.ok || !result.allowed) {
    throw new Error(
      `今月の高精度モード利用上限に達しました（${result.count ?? "-"}/${result.stopLimit ?? 850}）。標準モードをご利用ください。`
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
