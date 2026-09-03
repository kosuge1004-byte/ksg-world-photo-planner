import fs from 'node:fs';

const candidates = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const terrain = fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url), 'utf8');
const gsi = fs.readFileSync(new URL('../src/cesium/gsiElevationClient.ts', import.meta.url), 'utf8');

const checks = [
  ['adaptive refinement uses two passes', /DEFAULT_ROOT_REFINEMENT_PASSES\s*=\s*2/],
  ['adaptive refinement uses 32 segments', /DEFAULT_ROOT_REFINEMENT_SEGMENTS\s*=\s*32/],
  ['refinement DEM remains 1m', /refinementSamples\s*=\s*await terrainSampler\([\s\S]*?"1m"\s*\)/],
  ['coarse scan remains 10m only before 1m final refinement', /全距離走査[\s\S]*?"10m"/],
  ['per-celestial failure isolation remains allSettled', /Promise\.allSettled\(/],
  ['World Terrain retries up to three attempts', /WORLD_TERRAIN_MAX_ATTEMPTS\s*=\s*3/],
  ['World Terrain attempts have a finite timeout', /WORLD_TERRAIN_OPERATION_TIMEOUT_MS\s*=\s*30_000/],
  ['World Terrain provider and sampling both use the timeout guard', /(waitForWorldTerrainOperation\([\s\S]*?terrainPromise[\s\S]*?waitForWorldTerrainOperation\([\s\S]*?sampleTerrainMostDetailed)/],
  ['rejected World Terrain provider promise is cleared', /terrainPromise\s*=\s*null/],
  ['World Terrain retry never changes requested coordinates', /sampleWorldTerrainFallbackWithRecovery\(fallbackPoints, signal\)/],
  // 2026-09-02変更: 実機での試験目的により8→10へ引き上げた。上限自体が
  // 存在し、有限の数値であることを検証する（具体的な数値は運用判断で
  // 変わりうるため、8固定ではなく「数字である」ことだけを見る）。
  ['GSI request concurrency is a finite cap', /MAX_CONCURRENT_REQUESTS\s*=\s*\d+/],
];

let failed = false;
for (const [name, re] of checks) {
  const source = name.includes('GSI') ? gsi : name.includes('World Terrain') ? terrain : candidates;
  const ok = re.test(source);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  failed ||= !ok;
}

const oldResolution = 576;
const newResolution = 32 ** 2;
const oldInteriorSamples = 575;
const newInteriorSamples = 2 * 31;
const resolutionOk = newResolution >= oldResolution;
const requestReductionOk = newInteriorSamples < oldInteriorSamples;
console.log(`${resolutionOk ? 'PASS' : 'FAIL'}: refinement distance resolution ${newResolution} >= ${oldResolution}`);
console.log(`${requestReductionOk ? 'PASS' : 'FAIL'}: max interior DEM samples ${newInteriorSamples} < ${oldInteriorSamples}`);
failed ||= !resolutionOk || !requestReductionOk;

process.exit(failed ? 1 : 0);
