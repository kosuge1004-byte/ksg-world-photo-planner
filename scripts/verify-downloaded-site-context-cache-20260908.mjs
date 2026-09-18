import fs from 'node:fs';
const site = fs.readFileSync('src/search/siteContext.ts','utf8');
const cache = fs.readFileSync('src/cache/siteContextPersistentCache.ts','utf8');
const mgr = fs.readFileSync('src/cache/tripodBearingProfileManager.ts','utf8');
const app = fs.readFileSync('src/App.tsx','utf8');
const jobRunner = fs.readFileSync('server/runBearingProfileDownloadJob.ts','utf8');
const jobTypes = fs.readFileSync('src/types/backgroundBearingProfile.ts','utf8');
const checks = [
 ['persistent cache read before network', site.includes('readPersistentSiteContexts(points, purpose, includeDetails)')],
 ['persistent cache writes live results', site.includes('writePersistentSiteContexts(missingPoints, fetched')],
 // 2026-09-08追記: バックグラウンド探索(spotSearchJob)の座標契約は従来通り
 // SiteContextPoint[]。三脚候補周辺データダウンロードはサーバージョブ化に
 // 伴いSerializedSiteContextPoint（同じ{latitude, longitude}形状）を
 // src/types/backgroundBearingProfile.tsで共有する契約に変わった。
 ['coordinate-only point contract', jobTypes.includes('SerializedSiteContextPoint = {') && jobTypes.includes('latitude: number;') && jobTypes.includes('longitude: number;')],
 ['IndexedDB is runtime-guarded for non-browser builds', cache.includes('globalThis as unknown as { indexedDB?: IdbFactory }')],
 // 水面・河川情報とOSM周辺情報の取得は、サーバー側ジョブ(runBearingProfile
 // DownloadJob.ts)へ移動した。端末側は完了結果を書き込むだけになった。
 ['water-only prefetched by server job', jobRunner.includes('waterPrefetchPoints') && jobRunner.includes('fetchServerSiteContexts(waterPrefetchPoints') && mgr.includes('"water-only"')],
 ['full OSM near subject prefetched by server job', jobRunner.includes('fullSiteContextPoints') && mgr.includes('"full"')],
 ['spot refs stored', cache.includes('REF_STORE') && cache.includes('subjectId, keys')],
 ['shared safe delete', cache.includes('referencedElsewhere') || cache.includes('const other = new Set')],
 ['delete integrated', app.includes('deletePersistentSiteContextsForSpot(subjectId)')],
 ['30d TTL', cache.includes('30 * 24 * 60 * 60 * 1000')],
];
let fail=0; for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) fail++; }
console.log(`${checks.length-fail}/${checks.length} PASS`); process.exitCode=fail?1:0;
