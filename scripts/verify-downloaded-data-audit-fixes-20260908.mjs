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
 ['force refresh re-fetches all bearings', /forceRefresh \|\| !existing/.test(mgr)],
 ['complete requires live DEM', /dem\.referencedTiles === 0[\s\S]*dem\.liveTiles === 0/.test(stats)],
 ['progress has water phase', /phase: "water"/.test(mgr) && /水面・河川情報/.test(dialog)],
 ['progress has OSM phase', /phase: "osm"/.test(mgr) && /道路・立入・建物情報/.test(dialog)],
 ['progress has finalizing phase', /phase: "finalizing"/.test(mgr) && /保存を確定/.test(dialog)],
 ['preflight storage estimate', /navigator\.storage\?\.estimate/.test(app) && /estimatedRequired/.test(app)],
 ['tile write failures detected', /persistentTileWriteFailures \+= 1/.test(dem) && /storageWriteFailures/.test(mgr)],
 ['failed writes prevent complete registry', /storageWriteFailures > 0/.test(app) && /保存完了にはしていません/.test(app)],
 ['high precision test wired', /verify-downloaded-spot-high-precision-20260908/.test(runner)],
 ['site context test wired', /verify-downloaded-site-context-cache-20260908/.test(runner)],
];
let pass=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${n}`); if(ok)pass++;}
console.log(`download audit fixes: ${pass}/${checks.length} PASS`); if(pass!==checks.length)process.exit(1);
