import fs from 'node:fs';
const s=fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url),'utf8');
const checks=[
 ['terrain IDB open timeout',/TERRAIN_CACHE_OPEN_TIMEOUT_MS\s*=\s*1_500/],
 ['terrain IDB operation timeout',/TERRAIN_CACHE_OPERATION_TIMEOUT_MS\s*=\s*1_500/],
 ['blocked terrain cache fails open',/request\.onblocked\s*=\s*\(\)\s*=>\s*finish\(null\)/],
 ['failed terrain DB promise resets',/if \(!database && terrainCacheDatabasePromise === opening\)/],
 ['terrain batch read bounded',/boundedTerrainCacheOperation\([\s\S]*Promise\.all\(missing\.map/],
 ['invalid read transaction fails open',/InvalidStateError\/TransactionInactiveError[\s\S]*terrainCacheDatabasePromise = null/],
 ['terrain write bounded',/await boundedTerrainCacheOperation\([\s\S]*database\.transaction\(TERRAIN_CACHE_STORE, "readwrite"\)/],
 ['datum marker remains enforced',/record\.datum === "ellipsoidal-v1"/],
 ['device DEM datum conversion remains',/sample\.heightMeters \+ \(geoidHeightMeters as number\)/],
];
let n=0; for(const [name,re] of checks){if(!re.test(s)){console.error('FAIL:',name);process.exitCode=1}else{console.log('PASS:',name);n++}}
if(!process.exitCode) console.log(`PASS ${n}/${checks.length}`);
