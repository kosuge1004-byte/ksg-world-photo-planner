import type { RuntimeKvNamespace } from "./cloudflareRuntime.ts";

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
 */
export function persistentCacheFromR2(bucket: R2Bucket | undefined): RuntimeKvNamespace | undefined {
  if (!bucket) return undefined;
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object ? await object.arrayBuffer() : null;
    },
    async put(key, value) {
      await bucket.put(key, value);
    },
  };
}
