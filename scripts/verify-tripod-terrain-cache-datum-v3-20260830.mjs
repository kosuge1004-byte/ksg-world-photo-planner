import fs from 'node:fs';
const terrain = fs.readFileSync('src/cesium/worldTerrain.ts', 'utf8');
const tripod = fs.readFileSync('src/cesium/tripodCandidates.ts', 'utf8');
const checks = [
  [terrain.includes('ksg-world-photo-planner-terrain-v3'), 'terrain cache namespace bumped to v3'],
  [terrain.includes('datum: "ellipsoidal-v1"'), 'cache records carry explicit ellipsoidal datum marker'],
  [terrain.includes('record.datum === "ellipsoidal-v1"'), 'legacy/untyped terrain cache records are rejected'],
  [/result\[originalIndex\]\.height\s*=\s*sample\.heightMeters\s*\+\s*\(geoidHeightMeters as number\)/.test(terrain), 'device DEM H is converted to ellipsoidal h = H + N'],
  [terrain.includes('geoidHeightBySample.set(result[originalIndex], geoidHeightMeters as number)'), 'device-cache samples retain the N used for conversion'],
  [terrain.includes('geoidHeightBySample.set(result[index], geoidHeightMeters)'), 'network GSI samples retain the N used for conversion'],
  [terrain.includes('geoidHeightMeters: geoidHeightBySample.get(point)'), 'persistent terrain cache stores sample geoid metadata'],
  [tripod.includes('if (!Number.isFinite(sampledGeoid)) throw error'), 'point-specific geoid timeout falls back only when sampled N is available'],
  [tripod.includes('geoidForEllipsoidal = exactGeoid ?? geoidForOrthometric'), 'final candidate can preserve valid sampled datum on point-specific geoid failure'],
];
let failed = 0;
for (const [ok, name] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
