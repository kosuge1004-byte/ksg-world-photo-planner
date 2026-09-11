// 2026-09-11: 三脚候補データダウンロード時の水面・河川情報／被写体周辺OSM
// 情報の永続キャッシュ書き込みを削除した。保存座標(5桁小数)・purpose・
// includeDetailsの完全一致でしかキャッシュがヒットせず、ライブ検索側が
// 要求する組み合わせと一致する読み手が存在しなかったため、実質的に
// 再利用されないネットワーク要求・ダウンロード時間・端末保存容量だった。
// このファイルは旧仕様（サーバージョブ化案を含む）のチェックを行っていた
// ため、削除に合わせて無効化する。
import fs from 'node:fs';
const mgr = fs.readFileSync('src/cache/tripodBearingProfileManager.ts', 'utf8');
const checks = [
  ['water/osm site-context prefetch removed from download flow', !mgr.includes('waterPrefetchPoints') && !mgr.includes('phase: "water"') && !mgr.includes('phase: "osm"')],
];
let fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fail++; }
console.log(`${checks.length - fail}/${checks.length} PASS`);
process.exitCode = fail ? 1 : 0;
