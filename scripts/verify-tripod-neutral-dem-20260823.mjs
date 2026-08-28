import fs from 'node:fs';

const gsi = fs.readFileSync(new URL('../server/gsiElevation.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/gsi-elevation.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../src/cesium/gsiElevationClient.ts', import.meta.url), 'utf8');
const terrain = fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url), 'utf8');
const tripod = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');

const checks = [
  ['GSI request supports neutral/LOS modes', /interpolationMode\?: "los-safe" \| "neutral"/.test(gsi)],
  ['neutral 1m interpolation uses constrained bicubic without upward max bias', /interpolationMode === "neutral"[\s\S]*\? bicubicHeight[\s\S]*: Math\.max\(bilinearHeight, bicubicHeight\)/.test(gsi)],
  ['LOS-safe remains the default', /interpolationMode: "los-safe" \| "neutral" = "los-safe"/.test(gsi)],
  ['API parses interpolation mode', /interpolationMode:[\s\S]*value\.interpolationMode === "neutral"/.test(api)],
  // 2026-08-28追記: 「複数座標をまとめた外側のバッチキャッシュ」（この
  // 2項目が検証していたcacheKeyInput/namespace: "gsi-elevation"の記述）
  // は撤去した。代わりに「DEMタイル単位の永続キャッシュ」を使う設計に
  // 変わった。タイルの生データ自体は補間方式（interpolationMode）に
  // 関わらず共通（違うのは取得後の補間計算だけ）なので、タイル
  // キャッシュ側でinterpolationModeごとにキーを分ける必要がない
  // （むしろ分けない方が、los-safe/neutral間でも同じタイルを共有できて
  // 効率的）。APIがinterpolationModeをlookupGsiElevationsへ正しく
  // 渡していることを確認する。
  ['API forwards interpolation mode to lookupGsiElevations (2026-08-28)', /lookupGsiElevations\(points,/.test(api)],
  ['client transmits interpolation mode', /interpolationMode\?: "los-safe" \| "neutral"/.test(client)],
  // 2026-08-28追記: sampleWorldTerrainNeutralは、以前は独自に
  // fetchGsiElevationSamplesを直接呼んでいたが、端末側の永続キャッシュ
  // （sampleTerrainCached、IndexedDB）を経由するよう変更した。これにより
  // "neutral"という文字列は、fetchGsiElevationSamplesへの直接指定では
  // なく、sampleTerrainCachedへの引数として渡される形に変わったため、
  // 検証パターンを更新する。
  ['neutral terrain sampler requests neutral GSI (2026-08-28: via sampleTerrainCached)',
    /export async function sampleWorldTerrainNeutral[\s\S]*sampleTerrainCached[\s\S]*"neutral"/.test(terrain)],
  ['tripod calculator defaults to neutral terrain sampler', /terrainSampler: TerrainSampler = sampleWorldTerrainNeutral/.test(tripod)],
  ['tripod imports no ordinary sampleWorldTerrain fallback as default', !/import \{ sampleWorldTerrain, terrainDataSource \}/.test(tripod)],
];
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) process.exitCode = 1;
}
