import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const tripod = read('src/cesium/tripodCandidates.ts');
const terrain = read('src/cesium/worldTerrain.ts');
const app = read('src/App.tsx');
const dem = read('src/cesium/gsiDemTileCache.ts');
const checks = [
  ['full authoritative initial distance domain', tripod.includes('maxMeters: ABSOLUTE_MAX_DISTANCE_METERS') && !tripod.includes('if (primarySolutions.length > 0 || primaryMax >= ABSOLUTE_MAX_DISTANCE_METERS)')],
  ['expanded adaptive sample safety cap', tripod.includes('const ADAPTIVE_MAX_TOTAL_SAMPLES = 4096;')],
  ['tangent terrain contacts retained for refinement', tripod.includes('kind: "crossing" | "tangent"') && tripod.includes('state.kind === "tangent"')],
  ['bounded 2D manual refinement', tripod.includes('const bearingOffsets = [-bearingRadiusDegrees, 0, bearingRadiusDegrees]') && tripod.includes('const distanceOffsets = [-radiusMeters, 0, radiusMeters]')],
  ['candidate-local refraction weather re-resolved', tripod.includes('await refractionWeatherResolver(candidatePoint, signal)') && tripod.includes('candidateRefractionWeather')],
  ['device DEM stores geoid metadata', terrain.includes('geoidHeightBySample.set(result[originalIndex], geoidHeightMeters)')],
  ['network GSI stores geoid metadata', terrain.includes('geoidHeightBySample.set(result[index], geoidHeightMeters)')],
  ['terrain persistent cache stores source/geoid metadata', terrain.includes('geoidHeightMeters: geoidHeightBySample.get(point)') && terrain.includes('source: terrainSourceBySample.get(point)')],
  ['terrain cache schema bumped to avoid metadata-less legacy records', terrain.includes('ksg-world-photo-planner-terrain-v3')],
  ['in-flight key includes camera height and full celestial geometry', app.includes('lensCenterHeightMeters: cameraSettings.lensCenterHeightMeters') && app.includes('geometricAltitudeDegrees: p.geometricAltitudeDegrees ?? null')],
  ['aborted effect synchronously clears matching in-flight key', app.includes('if (tripodCalculationInFlightKeyRef.current === inFlightKey)') && app.includes('tripodCalculationInFlightKeyRef.current = null;')],
  ['device DEM IndexedDB timeout fallback', dem.includes('const INDEXED_DB_TIMEOUT_MS = 3_000;') && dem.includes('setTimeout(() => finish(null), INDEXED_DB_TIMEOUT_MS)')],
  ['terrain IndexedDB timeout fallback', terrain.includes('const TERRAIN_INDEXED_DB_TIMEOUT_MS = 3_000;') && terrain.includes('const timeout = setTimeout(finish, TERRAIN_INDEXED_DB_TIMEOUT_MS)')],
];
let failed=0;
for (const [name,ok] of checks) { console.log(`${ok?'PASS':'FAIL'}: ${name}`); if(!ok) failed++; }
if (failed) process.exit(1);
