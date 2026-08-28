import type { RuntimeKvNamespace } from "./cloudflareRuntime.ts";
import {
  allowR2Read,
  reserveR2Write,
  valueBytes,
  type R2SafetyKv,
  type R2MonthlyBudgetDb,
} from "./r2SafetyBudget.ts";

/**
 * DEMタイル本体・空判定の永続キャッシュをR2で提供するアダプタ。
 *
 * Workers KVへは書き込まない方針（三脚候補探索・スポット検索中の
 * DEM取得を対象にWORKERS_KV_PUT_REDUCTION各stageで意図的に0PUTへ
 * 削減し、scripts/verify-workers-kv-writes.mjsで維持している）はそのまま
 * 踏襲する。R2はそれとは別物で、functions/_shared/r2Cache.tsの標高
 * バッチキャッシュで既に同種の書き込み実績があるため、同じ経路
 * （bucket.put経由。env.X.putを直接書かない）をDEMタイル単位の
 * キャッシュにも適用する。
 *
 * functions/api/gsi-elevation.ts（対話的な三脚候補計算）と
 * workers/spot-search-consumer.ts（バックグラウンドのスポット検索）の
 * 両方から、それぞれのenv.NETWORK_CACHEを渡して使う。
 *
 * 2026-08-28追記: 国土地理院への外部通信（fetchGsiTileWithTimeout）には
 * 明示的に8秒のタイムアウトが設定されているのに対し、R2への内部アクセス
 * （bucket.get/put）には、これまでタイムアウト保護が一切なかった。
 * R2が一時的に通常より遅くなった場合、無期限に待ち続けてしまう
 * リスクがあったため、R2アクセスにも明示的なタイムアウトを設ける。
 * タイムアウトした場合は、既存のフェイルクローズ設計と一貫して
 * 「キャッシュなし」として扱い、国土地理院への直接取得へ安全に
 * フォールバックする（精度には一切影響しない）。
 */
const R2_ACCESS_TIMEOUT_MS = 5_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("R2アクセスがタイムアウトしました")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export function persistentCacheFromR2(
  bucket: R2Bucket | undefined,
  safetyKv?: R2SafetyKv,
  requestIdentity?: object,
  budgetDb?: R2MonthlyBudgetDb,
): RuntimeKvNamespace | undefined {
  if (!bucket) return undefined;
  const activeBucket = bucket;
  async function getWithStatus(key: string): Promise<{
    status: "hit" | "miss" | "bypass";
    value: ArrayBuffer | null;
  }> {
    // Fail closed: once the conservative Class B budget is reached,
    // bypass R2 entirely so the normal upstream path can run.
    if (!await allowR2Read(safetyKv, requestIdentity)) {
      return { status: "bypass", value: null };
    }
    try {
      const object = await withTimeout(activeBucket.get(key), R2_ACCESS_TIMEOUT_MS);
      if (!object) return { status: "miss", value: null };
      const value = await withTimeout(object.arrayBuffer(), R2_ACCESS_TIMEOUT_MS);
      return { status: "hit", value };
    } catch {
      // R2 failure is observably different from a key miss, while the elevation
      // path still falls back to GSI exactly as before.
      return { status: "bypass", value: null };
    }
  }
  return {
    async get(key) {
      return (await getWithStatus(key)).value;
    },
    async getWithStatus(key) {
      return getWithStatus(key);
    },
    async put(key, value) {
      const newBytes = valueBytes(value as ArrayBuffer | Uint8Array | string);
      if (!await reserveR2Write(safetyKv, key, newBytes, requestIdentity, budgetDb)) return;
      try {
        await withTimeout(activeBucket.put(key, value), R2_ACCESS_TIMEOUT_MS);
      } catch {
        // 保存の失敗は探索結果に影響させない（次回また通常取得へフォールバック）。
      }
    },
  };
}
