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
 // 2026-09-30: 保存完了済みの更新は全再取得、「一部不足」の更新は保存済み方位を残して不足分だけ取得する。
  ['refresh explicitly forceRefresh', /forceRefresh: record\.status === "complete"/.test(app) &&
   // 2026-10-09: 取得呼び出しをrunBackfillへまとめた（内蔵スポットで探索距離が計算済みデータの
   // 範囲を超える場合の段階取得のため）。更新時のforceRefreshは従来どおり取得処理へ渡る。
   /forceRefresh: options\.forceRefresh,[\s\S]{0,200}?onProgress/.test(app) &&
   /runBackfill\(\{ maxDistanceMeters: requestedMaxDistanceMeters, forceRefresh \}\)/.test(app)],
 ['force refresh rebuilds all bearings', /if \(forceRefresh\) return true/.test(mgr)],
 ['complete requires live DEM', /dem\.referencedTiles === 0[\s\S]*dem\.liveTiles === 0/.test(stats)],
 // 2026-09-09追記: サーバー側ジョブ化を差し戻し、水面・河川情報とOSM周辺
 // 情報の取得はクライアント側（tripodBearingProfileManager.ts）が
 // 直接行う元の設計に戻った。
 // 2026-09-30: 水面・河川情報とOSM周辺情報の保存はダウンロードから外した
 // （端末キャッシュは約1m一致でしか読まれず、保存値が実際に参照されていなかった）。
 ['download no longer stores water/OSM site data', !/phase: "water"/.test(mgr) && !/phase: "osm"/.test(mgr) && !/fetchSiteContexts/.test(mgr)],
 ['site data does not decide the partial state', !/site\.liveCount === 0/.test(stats) && !/site\.expiredCount > 0/.test(stats)],
 ['progress has finalizing phase', /phase: "finalizing"/.test(mgr) && /保存を確定/.test(dialog)],
 ['preflight storage estimate', /navigator\.storage\?\.estimate/.test(app) && /estimatedRequired/.test(app)],
 ['tile write failures detected', /persistentTileWriteFailures \+= 1/.test(dem) && /storageWriteFailures/.test(mgr)],
 ['failed writes prevent complete registry', /storageWriteFailures > 0/.test(app) && /保存完了にはしていません/.test(app)],
 ['high precision test wired', /verify-downloaded-spot-high-precision-20260908/.test(runner)],
 ['site context test wired', /verify-downloaded-site-context-cache-20260908/.test(runner)],
];
let pass=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${n}`); if(ok)pass++;}
console.log(`download audit fixes: ${pass}/${checks.length} PASS`); if(pass!==checks.length)process.exit(1);
