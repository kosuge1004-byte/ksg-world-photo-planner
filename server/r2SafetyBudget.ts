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
 * 根本対策: このガードからWorkers KVへのアクセスを完全に無くす。
 * R2自体の無料枠（月100万回書き込み・月1000万回読み取り）は、通常利用は
 * もちろん、このアプリの開発・検証作業でも現実的には到達しない規模
 * であるため、月間の正確な集計をKV経由で行う必要性自体が薄い。
 * 代わりに、以下の2点だけで十分な安全マージンを持たせる:
 *   1) 1リクエストあたりの読み書き回数の上限
 *      （メモリ上のWeakMapのみで完結。KV不使用）
 *   2) 1オブジェクトあたりの最大バイト数の上限
 *      （計算のみで完結。KV不使用）
 * これにより、単一のリクエストが暴走してR2やKVを食い潰すことは防ぎつつ、
 * 通常アクセス・開発中の検証作業のいずれでも、KVの無料枠を圧迫する
 * ことが一切なくなる。
 *
 * 月間の保存容量・書き込み総数を厳密に把握したい場合は、Cloudflare
 * ダッシュボードのR2使用量画面で確認できる（無料枠が10GB・月100万回と
 * 大きいため、リアルタイムのアプリ側集計がなくても実用上問題ない）。
 */

export interface R2SafetyKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const R2_MAX_CACHE_OBJECT_BYTES = 512 * 1024;
export const R2_MAX_WRITES_PER_REQUEST = 64;
export const R2_MAX_READS_PER_REQUEST = 256;

type RequestCounts = { reads: number; writes: number };
const perRequest = new WeakMap<object, RequestCounts>();
function counts(id?: object): RequestCounts {
  if (!id) return { reads: 0, writes: 0 };
  let v = perRequest.get(id);
  if (!v) { v = { reads: 0, writes: 0 }; perRequest.set(id, v); }
  return v;
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
 * R2への書き込みを許可するかどうか。KVには一切アクセスしない。
 * 1リクエストあたりの書き込み回数上限と、1オブジェクトあたりの
 * 最大バイト数だけで判定する。
 */
export async function reserveR2Write(
  kv: R2SafetyKv | undefined,
  objectKey: string,
  newBytes: number,
  id?: object
): Promise<boolean> {
  void objectKey; // 2026-08-26: 個別オブジェクトのサイズ追跡（KV経由）を廃止したため未使用。シグネチャは呼び出し元との互換のため維持。
  if (!kv || !Number.isFinite(newBytes) || newBytes < 0 || newBytes > R2_MAX_CACHE_OBJECT_BYTES) return false;
  const c = counts(id);
  if (c.writes >= R2_MAX_WRITES_PER_REQUEST) return false;
  c.writes++;
  return true;
}

export function valueBytes(value: string | ArrayBuffer | Uint8Array): number {
  return typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
}
