/**
 * Application-side R2 write/read guard.
 *
 * R2 は有効なまま使い、無料枠を超えないためのアプリ側上限だけをここで
 * 強制する。Workers KV はジョブ保存にも使うため、カウンター更新には使わず、
 * 無料枠が大きく原子的な更新ができる D1 を共有する。
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
 * 上限は Standard R2 無料枠より十分低く固定する:
 *   新規保存予約量 4 GB / 全期間、Class A相当 10万回/月、
 *   Class B相当 100万回/月。
 * D1が無い、または集計に失敗した場合はR2アクセスを許可しない。アプリ本体は
 * 国土地理院等の通常経路へフォールバックするため、精度と機能は維持される。
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
export const R2_MONTHLY_WRITE_BUDGET = 100_000;
export const R2_MONTHLY_READ_BUDGET = 1_000_000;
export const R2_STORAGE_RESERVATION_BUDGET_BYTES = 4_000_000_000;
const R2_READ_RESERVATION_BLOCK = 32;

type RequestCounts = { reads: number; reservedReads: number; writes: number };
const perRequest = new WeakMap<object, RequestCounts>();
function counts(id?: object): RequestCounts {
  if (!id) return { reads: 0, reservedReads: 0, writes: 0 };
  let v = perRequest.get(id);
  if (!v) { v = { reads: 0, reservedReads: 0, writes: 0 }; perRequest.set(id, v); }
  return v;
}

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 指定カウンターを上限以内でだけアトミックに予約する。
 * 上限到達、D1未設定、D1障害はいずれも null としてフェイルクローズする。
 */
async function reserveCounter(
  db: R2MonthlyBudgetDb | undefined,
  key: string,
  increment: number,
  limit: number,
): Promise<number | null> {
  if (!db) return null;
  try {
    const result = await db
      .prepare(
        `INSERT INTO r2_write_budget (month, writes) VALUES (?1, ?2)
         ON CONFLICT(month) DO UPDATE SET writes = writes + ?2
           WHERE writes + ?2 <= ?3
         RETURNING writes`
      )
      .bind(key, increment, limit)
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
export async function allowR2Read(
  kv: R2SafetyKv | undefined,
  id?: object,
  budgetDb?: R2MonthlyBudgetDb,
): Promise<boolean> {
  if (!kv || !budgetDb) return false;
  const c = counts(id);
  if (c.reads >= R2_MAX_READS_PER_REQUEST) return false;
  if (c.reads >= c.reservedReads) {
    // D1往復を各R2読み取りに追加しないよう、同一リクエスト分を32回ずつ
    // 先に予約する。未使用分は戻さないため集計誤差は常に安全側になる。
    const reservation = Math.min(
      R2_READ_RESERVATION_BLOCK,
      R2_MAX_READS_PER_REQUEST - c.reservedReads,
    );
    const monthlyReads = await reserveCounter(
      budgetDb,
      `read:${monthKey()}`,
      reservation,
      R2_MONTHLY_READ_BUDGET,
    );
    if (monthlyReads === null) return false;
    c.reservedReads += reservation;
  }
  c.reads++;
  return true;
}

/**
 * R2への書き込みを許可するかどうか。
 * 1リクエストあたりの書き込み回数上限・1オブジェクトあたりの最大
 * バイト数（KV不使用）に加え、D1で月間書き込み回数と全期間の保存予約量を
 * 確認する。D1未設定・D1エラー・いずれかの上限到達時は拒否する。
 */
export async function reserveR2Write(
  kv: R2SafetyKv | undefined,
  objectKey: string,
  newBytes: number,
  id?: object,
  budgetDb?: R2MonthlyBudgetDb
): Promise<boolean> {
  void objectKey; // 2026-08-26: 個別オブジェクトのサイズ追跡（KV経由）を廃止したため未使用。シグネチャは呼び出し元との互換のため維持。
  if (!kv || !budgetDb || !Number.isFinite(newBytes) || newBytes < 0 || newBytes > R2_MAX_CACHE_OBJECT_BYTES) return false;
  const c = counts(id);
  if (c.writes >= R2_MAX_WRITES_PER_REQUEST) return false;

  const monthlyWrites = await reserveCounter(
    budgetDb,
    `write:${monthKey()}`,
    1,
    R2_MONTHLY_WRITE_BUDGET,
  );
  if (monthlyWrites === null) return false;

  // 実書き込み前に予約し、失敗や同一キー上書きでも減算しない。容量を
  // 過大評価する方向だけに誤差が出るため、課金防止側には安全に倒れる。
  const reservedBytes = await reserveCounter(
    budgetDb,
    "storage-reserved-bytes:v1",
    newBytes,
    R2_STORAGE_RESERVATION_BUDGET_BYTES,
  );
  if (reservedBytes === null) return false;

  c.writes++;
  return true;
}

export function valueBytes(value: string | ArrayBuffer | Uint8Array): number {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}
