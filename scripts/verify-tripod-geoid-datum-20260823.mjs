import fs from 'node:fs';
const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const terrain = fs.readFileSync('src/cesium/worldTerrain.ts','utf8');
const serverTerrain = fs.readFileSync('server/worldTerrain.ts','utf8');
const checks = [
  [!tripod.includes('const geoid = subject.geoidHeightMeters'), 'candidate no longer copies subject geoid'],
  [tripod.includes('geoidHeightMetersForTerrainSample(cartographic)'), 'candidate uses geoid actually attached to its terrain sample'],
  [tripod.includes('fetchGsiGeoidHeightPointSpecific(cartographic, signal)'), 'final candidate resolves point-specific geoid'],
  [tripod.includes('orthometric = Number.isFinite(sampledGeoid)'), 'final candidate preserves DEM orthometric H before replacing N'],
  [tripod.includes('ellipsoidal = orthometric + exactGeoid'), 'final candidate rebuilds h = H + N'],
  [tripod.includes('finalCartographic'), 'final geometry uses corrected ellipsoidal height'],
  [tripod.includes('height: ellipsoidalHeightMeters(finalCandidatePoint)'), 'returned candidate carries corrected ellipsoidal height'],
  [terrain.includes('pointSpecific ? "&precision=point" : ""'), 'client requests point-specific geoid API mode'],
  [terrain.includes('geoidHeightBySample.set(result[index], geoidHeightMeters)'), 'neutral DEM stores the geoid used for each sample'],
  [!serverTerrain.includes('const midpoint = result[Math.floor(result.length / 2)]'), 'server no longer applies one midpoint geoid to whole batch'],
];
let fail=0;
for (const [ok,name] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) fail++; }
if(fail) process.exit(1);
