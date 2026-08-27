/**
 * Application-side R2 write/read guard.
 *
 * 2026-08-26 大幅刷新: 以前はここでWorkers KVを使い、「今月R2を何回
 * 使ったか」を月単位で正確に集計していた。しかし実際に運用してみると、
 * 見張られている側のR2よりも、見張り役のKVの方がずっと厳しい無料枠しか
 * 持たない、という本末転倒な構造だったことが判明した:
 *
 *   R2 書き込み(Class A) : 100万回/月   (Cloudflare公式無料枠)
 *   R2 読み取り(Class B) : 1000万回/月  (Cloudflare公式無料枠)
 *   KV 書き込み          : 1,000回/日   (Cloudflare公式無料枠。R2書き込み
 *                                        換算で月3万回相当しかない)
 *   KV 読み取り          : 10万回/日
 *
 * KVでの集計を間引く（サンプリング）対症療法を重ねても、「R2への
 * アクセスのたびにKVへ触れる」という構造自体が残る限り、アクセス量が
 * 増えれば必ずまたKVの日次上限に先に到達してしまう
 * （実際に開発中の検証作業だけで複数回到達した）。
 *
 * 2026-08-27追記: 開発中の検証作業だけならR2の無料枠に到達する現実的な
 * リスクは低いが、実際に利用者が数千人規模に増えた場合は話が別（試算では
 * 数千〜1万人規模でR2の月間無料枠に到達しうる）。さらに支払い方法を
 * 登録済みのため、無料枠を超えた分は自動的に課金される。Cloudflare自体に
 * 「無料枠を超えたら完全に止める」機能は存在しない
 * （Budget Alertsは事後の通知のみで、しかも1日遅れ）ため、アプリ側で
 * 事前に確実に止める仕組みが必要。
 *
 * KVの代わりに Cloudflare D1（無料枠: 書き込み100,000回/日 = KVの100倍）
 * を使い、月間のR2書き込み総数を数える。D1はPages Functionsに直接
 * バインディングできる（Durable Objectsのような別Worker新設が不要）ため、
 * KV/R2と同じ運用感で組み込める。R2自体の無料枠（月100万回書き込み）に
 * 対して10%の安全マージンを残した90万回に達したら、以降は新規のR2書き込み
 * （＝キャッシュへの保存）を諦め、直接処理へフォールバックする
 * （読み取り・アプリの表示自体は止めない。速度が落ちるだけ）。
 */

export interface R2SafetyKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * D1データベースの最小限のインターフェース（実際のD1Database型の
 * サブセット）。テスト時にモックしやすいよう、必要なメソッドだけを定義。
 */
export interface R2MonthlyBudgetDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(colName?: string): Promise<T | null>;
    };
  };
}

export const R2_MAX_CACHE_OBJECT_BYTES = 512 * 1024;
export const R2_MAX_WRITES_PER_REQUEST = 64;
export const R2_MAX_READS_PER_REQUEST = 256;
// R2自体の無料枠（月100万回書き込み）に対し10%の安全マージンを残す。
export const R2_MONTHLY_WRITE_BUDGET = 900_000;

type RequestCounts = { reads: number; writes: number };
const perRequest = new WeakMap<object, RequestCounts>();
function counts(id?: object): RequestCounts {
  if (!id) return { reads: 0, writes: 0 };
  let v = perRequest.get(id);
  if (!v) { v = { reads: 0, writes: 0 }; perRequest.set(id, v); }
  return v;
}

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 月間のR2書き込み回数をD1でアトミックに1件加算し、その後の値を返す。
 * D1未設定、またはD1側で何らかのエラーが起きた場合は、月間予算の
 * チェック自体をスキップする（従来どおりリクエスト単位の上限のみで
 * 判定するフェイルオープン。月間集計という「追加の安全網」だけが
 * 無効になるだけで、基本の暴走防止は維持される）。
 */
async function incrementMonthlyR2Writes(db: R2MonthlyBudgetDb | undefined): Promise<number | null> {
  if (!db) return null;
  try {
    const result = await db
      .prepare(
        `INSERT INTO r2_write_budget (month, writes) VALUES (?1, 1)
         ON CONFLICT(month) DO UPDATE SET writes = writes + 1
         RETURNING writes`
      )
      .bind(monthKey())
      .first<{ writes: number }>();
    return result ? result.writes : null;
  } catch {
    return null;
  }
}

/**
 * R2からの読み取りを許可するかどうか。KVには一切アクセスしない。
 * kvが未設定（＝R2/KVどちらも無効な環境）の場合のみ、安全側に倒して
 * falseを返す（呼び出し元がkvの有無自体を「R2キャッシュが構成された
 * 環境かどうか」の判定に使っているため、後方互換としてこの挙動を残す）。
 */
export async function allowR2Read(kv: R2SafetyKv | undefined, id?: object): Promise<boolean> {
  if (!kv) return false;
  const c = counts(id);
  if (c.reads >= R2_MAX_READS_PER_REQUEST) return false;
  c.reads++;
  return true;
}

/**
 * R2への書き込みを許可するかどうか。
 * 1リクエストあたりの書き込み回数上限・1オブジェクトあたりの最大
 * バイト数（KV不使用）に加え、budgetDb（D1）が渡された場合のみ、
 * 月間のR2書き込み総数を確認する（R2無料枠の90%に達したら拒否）。
 * budgetDb未設定、またはD1エラー時は月間チェックをスキップする
 * （フェイルオープン。基本の暴走防止＝リクエスト単位の上限は維持される）。
 */
export async function reserveR2Write(
  kv: R2SafetyKv | undefined,
  objectKey: string,
  newBytes: number,
  id?: object,
  budgetDb?: R2MonthlyBudgetDb
): Promise<boolean> {
  void objectKey; // 2026-08-26: 個別オブジェクトのサイズ追跡（KV経由）を廃止したため未使用。シグネチャは呼び出し元との互換のため維持。
  if (!kv || !Number.isFinite(newBytes) || newBytes < 0 || newBytes > R2_MAX_CACHE_OBJECT_BYTES) return false;
  const c = counts(id);
  if (c.writes >= R2_MAX_WRITES_PER_REQUEST) return false;

  const monthlyWrites = await incrementMonthlyR2Writes(budgetDb);
  if (monthlyWrites !== null && monthlyWrites > R2_MONTHLY_WRITE_BUDGET) return false;

  c.writes++;
  return true;
}

export function valueBytes(value: string | ArrayBuffer | Uint8Array): number {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}
