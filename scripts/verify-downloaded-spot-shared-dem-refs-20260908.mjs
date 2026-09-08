import fs from 'node:fs';
const dem = fs.readFileSync('src/cesium/gsiDemTileCache.ts','utf8');
const app = fs.readFileSync('src/App.tsx','utf8');
const manager = fs.readFileSync('src/cache/tripodBearingProfileManager.ts','utf8');
const ui = fs.readFileSync('src/components/SpotSearchScreen.tsx','utf8');
const checks = [
 ['spot ref IndexedDB store', dem.includes('SPOT_REF_STORE_NAME = "spotRefs"') && dem.includes('indexedDb.open(DB_NAME, 2)')],
 ['explicit per-spot tile reference capture', dem.includes('recordGsiDeviceTileReferencesForPoints') && manager.includes('recordGsiDeviceTileReferencesForPoints(')],
 ['shared tiles retained', dem.includes('referencedElsewhere') && dem.includes('retainedSharedTiles')],
 ['unshared tile deletion wired', app.includes('deleteGsiDeviceTilesForDownloadedSpot(subjectId)')],
 ['actual bytes measured', dem.includes('record.heightsBuffer?.byteLength') && app.includes('demTileBytes: backfillResult.demTileBytes')],
 ['actual tile count measured', app.includes('demTileCount: backfillResult.demTileCount')],
 ['per-spot capacity shown', ui.includes('DEM') && ui.includes('formatBytes(stats?.demBytes ?? record.demTileBytes)')],
 ['total capacity shown', ui.includes('管理対象') && ui.includes('uniqueDemBytes')],
 ['no valid count eviction', dem.includes('PERSISTED_MAX_ENTRIES = Number.POSITIVE_INFINITY')],
];
let pass=0;
for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(ok) pass++; }
console.log(`PASS ${pass}/${checks.length}`);
if(pass!==checks.length) process.exit(1);
