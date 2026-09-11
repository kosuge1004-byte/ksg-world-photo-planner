import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8');
const dem=read('src/cesium/gsiDemTileCache.ts');
const mgr=read('src/cache/tripodBearingProfileManager.ts');
const stats=read('src/cache/downloadedSpotDataStats.ts');
const app=read('src/App.tsx');
const dialog=read('src/components/BearingProfileDownloadDialog.tsx');
const runner=read('scripts/run-regression-tests.mjs');
const checks=[
 ['DEM refs union existing + new', dem.includes('new Set(previous?.tileKeys ?? [])') && dem.includes('tileKeys.forEach((key) => merged.add(key))')],
 ['refresh explicitly forceRefresh', /forceRefresh: true/.test(app) && /forceRefresh,\s*onProgress/.test(app)],
 ['force refresh re-fetches all bearings', /if \(forceRefresh\) return true;/.test(mgr)],
 ['complete requires live DEM', /dem\.referencedTiles === 0[\s\S]*dem\.liveTiles === 0/.test(stats)],
 // 2026-09-09追記: サーバー側ジョブ化を差し戻し、水面・河川情報とOSM周辺
 // 情報の取得はクライアント側（tripodBearingProfileManager.ts）が
 // 直接行う元の設計に戻った。
 // 2026-09-11追記: その水面・河川情報／OSM周辺情報の永続キャッシュ書き込み自体を
 // 削除した（保存座標・purpose・includeDetailsの完全一致でしかヒットせず、
 // ライブ検索側が要求する組み合わせと一致する読み手が存在しなかったため）。
 // よってwater/osmフェーズはもう存在しない。
 ['water/osm phases removed (unused site-context prefetch deleted)', !/phase: "water"/.test(mgr) && !/phase: "osm"/.test(mgr) && !/水面・河川情報 \$\{/.test(dialog) && !/道路・立入・建物情報を保存/.test(dialog)],
 ['progress has finalizing phase', /phase: "finalizing"/.test(mgr) && /保存を確定/.test(dialog)],
 ['preflight storage estimate', /navigator\.storage\?\.estimate/.test(app) && /estimatedRequired/.test(app)],
 ['tile write failures detected', /persistentTileWriteFailures \+= 1/.test(dem) && /storageWriteFailures/.test(mgr)],
 ['failed writes prevent complete registry', /storageWriteFailures > 0/.test(app) && /保存完了にはしていません/.test(app)],
 ['high precision test wired', /verify-downloaded-spot-high-precision-20260908/.test(runner)],
 ['site context test wired', /verify-downloaded-site-context-cache-20260908/.test(runner)],
];
let pass=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${n}`); if(ok)pass++;}
console.log(`download audit fixes: ${pass}/${checks.length} PASS`); if(pass!==checks.length)process.exit(1);
