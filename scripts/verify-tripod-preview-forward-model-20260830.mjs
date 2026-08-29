import fs from 'node:fs';
const tripod = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const terrain = fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url), 'utf8');
const resolver = fs.readFileSync(new URL('../src/height/heightResolver.ts', import.meta.url), 'utf8');
const checks = [
  ['manual preview ground resolution uses groundPointFromCoordinates', /resolveGroundPoint[\s\S]*groundPointFromCoordinates/.test(resolver)],
  ['groundPointFromCoordinates uses sampleWorldTerrain', /groundPointFromCoordinates[\s\S]*sampleWorldTerrain\(\[requested\]\)/.test(terrain)],
  ['tripod exact search defaults to sampleWorldTerrain', /calculateTripodCandidates\([\s\S]*terrainSampler: TerrainSampler = sampleWorldTerrain/.test(tripod)],
  ['directional tripod sampling defaults to sampleWorldTerrain', /sampleDirectionalTripodCandidates\([\s\S]*terrainSampler: TerrainSampler = sampleWorldTerrain/.test(tripod)],
  ['tripod search does not default to neutral terrain', !/terrainSampler: TerrainSampler = sampleWorldTerrainNeutral/.test(tripod)],
  ['aligned candidate placement no longer overwrites resolved preview height with candidate.height', !/candidate\.solutionType === "aligned"[\s\S]{0,500}ellipsoidalHeightMeters: candidate\.height/.test(app)],
  ['candidate placement resolves final ground through resolveGroundPoint', /placeTripodAtCandidateConfirmed[\s\S]*resolveGroundPoint\(candidate\.latitude, candidate\.longitude, candidate\.label\)/.test(app)],
  ['round-trip still uses preview CameraModel projection path', /verifyRoundTripProjection[\s\S]*createCameraProjection[\s\S]*projectHorizontalToPreview/.test(tripod)],
];
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); if (!ok) process.exitCode = 1; }
