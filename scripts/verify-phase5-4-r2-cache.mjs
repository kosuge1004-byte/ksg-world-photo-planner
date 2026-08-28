import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");
const cache = read("functions/_shared/r2Cache.ts");
const env = read("functions/_shared/env.ts");
const files = ["timezone.ts", "geocode.ts", "gsi-geoid.ts", "osm-site-context.ts"].map((name) => read(`functions/api/${name}`));
// 2026-08-28追記: gsi-elevation.tsは「複数座標をまとめた外側の
// バッチキャッシュ」（getOrCreateR2Json経由）を撤去し、本当に効果の
// ある「DEMタイル単位のR2永続キャッシュ」（lookupGsiElevations経由）を
// 直接使う設計に変わったため、files配列からは除外し、別途確認する。
const gsiElevationEndpoint = read("functions/api/gsi-elevation.ts");
const gsiElevationServer = read("server/gsiElevation.ts");

const checks = [
  [env.includes("NETWORK_CACHE?: R2Bucket"), "optional R2 binding"],
  [cache.includes("stableSerialize") && cache.includes("SHA-256"), "stable hashed key"],
  [cache.includes("expiresAt") && cache.includes("version"), "TTL and version envelope"],
  [cache.includes("inFlight") && cache.includes('cache: "shared"'), "stampede protection"],
  [cache.includes("allowR2Read") && cache.includes("reserveR2Write"), "R2 read/write budget guards"],
  // 2026-08-26: KVベースの月間保存容量集計(trackedObjectBytes)は撤廃。
  // KVの無料枠(1日1000回)がR2の無料枠(月100万回)よりずっと厳しく、
  // 見張り役がR2本体より先に破綻する構造だったため。R2使用量の監視は
  // Cloudflareダッシュボードのネイティブなbudget alertsに委ねる。
  [!cache.includes("trackedObjectBytes"), "no KV-based storage accounting (removed 2026-08-26)"],
  [!cache.includes("bucket.delete(key)"), "no unguarded R2 delete"],
  [files.every((text) => text.includes("getOrCreateR2Json")), "endpoint integration"],
  [
    gsiElevationEndpoint.includes("lookupGsiElevations(") && gsiElevationServer.includes("serverPersistentCache("),
    "GSI cache (tile-level, 2026-08-28)",
  ],
  [files.some((text) => text.includes('namespace: "osm-site-context"')), "OSM cache"],
];
for (const [ok, label] of checks) {
  if (!ok) throw new Error(`Phase5-4 verification failed: ${label}`);
}
console.log("Phase5-4 verification passed");
