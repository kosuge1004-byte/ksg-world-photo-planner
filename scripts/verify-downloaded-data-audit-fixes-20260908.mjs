import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8');
const dem=read('src/cesium/gsiDemTileCache.ts');
const mgr=read('src/cache/tripodBearingProfileManager.ts');
const stats=read('src/cache/downloadedSpotDataStats.ts');
const app=read('src/App.tsx');
const dialog=read('src/components/BearingProfileDownloadDialog.tsx');
const runner=read('scripts/run-regression-tests.mjs');
const jobRunner=read('server/runBearingProfileDownloadJob.ts');
const checks=[
 ['DEM refs union existing + new', dem.includes('new Set(previous?.tileKeys ?? [])') && dem.includes('tileKeys.forEach((key) => merged.add(key))')],
 ['refresh explicitly forceRefresh', /forceRefresh: true/.test(app) && /forceRefresh,\s*onProgress/.test(app)],
 ['force refresh re-fetches all bearings', /forceRefresh \|\| !existing/.test(mgr)],
 ['complete requires live DEM', /dem\.referencedTiles === 0[\s\S]*dem\.liveTiles === 0/.test(stats)],
 // 2026-09-08追記: 水面・河川情報とOSM周辺情報の取得は、サーバー側
 // バックグラウンドジョブ(server/runBearingProfileDownloadJob.ts)へ移動した。
 // 端末側(tripodBearingProfileManager.ts)はもうこの通信を行わず、完了した
 // ジョブ結果を受け取ってwritePersistentSiteContextsで書き込むだけになった。
 ['server job fetches water/river context', /fetchServerSiteContexts\(waterPrefetchPoints, undefined, false\)/.test(jobRunner)],
 ['server job fetches full OSM context near subject', /fetchServerSiteContexts\(fullSiteContextPoints, undefined, true\)/.test(jobRunner)],
 ['client writes server-fetched site contexts on completion', /writePersistentSiteContexts\(\s*job\.waterSiteContextPoints/.test(mgr) && /writePersistentSiteContexts\(\s*job\.fullSiteContextPoints/.test(mgr)],
 ['progress has finalizing phase', /phase: "finalizing"/.test(mgr) && /保存を確定/.test(dialog)],
 ['preflight storage estimate', /navigator\.storage\?\.estimate/.test(app) && /estimatedRequired/.test(app)],
 ['tile write failures detected', /persistentTileWriteFailures \+= 1/.test(dem) && /storageWriteFailures/.test(mgr)],
 ['failed writes prevent complete registry', /storageWriteFailures > 0/.test(app) && /保存完了にはしていません/.test(app)],
 ['high precision test wired', /verify-downloaded-spot-high-precision-20260908/.test(runner)],
 ['site context test wired', /verify-downloaded-site-context-cache-20260908/.test(runner)],
];
let pass=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${n}`); if(ok)pass++;}
console.log(`download audit fixes: ${pass}/${checks.length} PASS`); if(pass!==checks.length)process.exit(1);
