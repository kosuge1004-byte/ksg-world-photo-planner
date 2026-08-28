import fs from "node:fs";

const r2 = fs.readFileSync(new URL("../functions/_shared/r2Cache.ts", import.meta.url), "utf8");
const elev = fs.readFileSync(new URL("../functions/api/gsi-elevation.ts", import.meta.url), "utf8");
const geoid = fs.readFileSync(new URL("../functions/api/gsi-geoid.ts", import.meta.url), "utf8");
const dem = fs.readFileSync(new URL("../server/gsiElevation.ts", import.meta.url), "utf8");
const geoidCore = fs.readFileSync(new URL("../server/gsiGeoid.ts", import.meta.url), "utf8");

const checks = [
  [r2.includes('ttlSeconds?: number | null'), 'R2 helper supports no-expiry'],
  [r2.includes('envelope.expiresAt === null'), 'R2 helper accepts non-expiring envelope'],
  // 2026-08-28追記: gsi-elevation.tsは「複数座標をまとめた外側の
  // バッチキャッシュ」（namespace: "gsi-elevation"の行はまさにこの層）
  // を撤去し、本当に効果のある「DEMタイル単位のR2永続キャッシュ」
  // （server/gsiElevation.tsのwritePersistentTile、expirationTtl未指定
  // ＝R2のデフォルトである無期限保存）を直接使う設計に変わったため、
  // タイル側のキャッシュが有効期限なしであることを確認する。
  [!dem.includes('expirationTtl'), 'DEM tile cache is non-expiring (2026-08-28)'],
  [geoid.includes('namespace: "gsi-geoid", version: "v2", ttlSeconds: null'), 'point geoid cache is non-expiring'],
  [geoid.includes('namespace: "gsi-geoid-batch", version: "v2", ttlSeconds: null'), 'batch geoid cache is non-expiring'],
  [dem.includes('gsi-decoded-dem-v2/'), 'decoded DEM tiles remain persistent/versioned'],
  [geoidCore.includes('geoid/v1/'), 'raw geoid values remain persistent/versioned'],
];
let failed = 0;
for (const [ok, name] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
