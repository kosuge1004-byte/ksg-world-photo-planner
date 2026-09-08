import fs from 'node:fs';
const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const terrain = fs.readFileSync('src/cesium/worldTerrain.ts','utf8');
const serverTerrain = fs.readFileSync('server/worldTerrain.ts','utf8');
const checks = [
  [!tripod.includes('const geoid = subject.geoidHeightMeters'), 'candidate no longer copies subject geoid'],
  [tripod.includes('geoidHeightMetersForTerrainSample(cartographic)'), 'candidate uses geoid actually attached to its terrain sample'],
  [tripod.includes('fetchGsiGeoidHeightPointSpecific(cartographic, signal, pointGeoidTimeoutMs)'), 'final candidate resolves point-specific geoid'],
  [tripod.includes('cartographic.height - geoidForOrthometric'), 'final candidate preserves DEM orthometric H before replacing N'],
  [tripod.includes('const ellipsoidal = orthometric + geoidForEllipsoidal'), 'final candidate rebuilds h = H + N'],
  [tripod.includes('ellipsoidalHeightMeters: ellipsoidal'), 'final geometry uses corrected ellipsoidal height'],
  [tripod.includes('height: ellipsoidal'), 'returned candidate carries corrected ellipsoidal height'],
  [terrain.includes('pointSpecific ? "&precision=point" : ""'), 'client requests point-specific geoid API mode'],
  [terrain.includes('geoidHeightBySample.set(result[index], geoidHeightMeters)'), 'neutral DEM stores the geoid used for each sample'],
  [!serverTerrain.includes('const midpoint = result[Math.floor(result.length / 2)]'), 'server no longer applies one midpoint geoid to whole batch'],
];
let fail=0;
for (const [ok,name] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) fail++; }
if(fail) process.exit(1);
