import fs from 'node:fs';

const gsi = fs.readFileSync(new URL('../server/gsiElevation.ts', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/gsi-elevation.ts', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../src/cesium/gsiElevationClient.ts', import.meta.url), 'utf8');
const terrain = fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url), 'utf8');
const tripod = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');

const checks = [
  ['GSI request supports neutral/LOS modes', /interpolationMode\?: "los-safe" \| "neutral"/.test(gsi)],
  ['neutral 1m interpolation uses constrained bicubic without upward max bias', /interpolationMode === "neutral"[\s\S]*\? bicubicHeight[\s\S]*: Math\.max\(bilinearHeight, bicubicHeight\)/.test(gsi)],
  ['LOS-safe remains the default', /interpolationMode: "los-safe" \| "neutral" = "los-safe"/.test(gsi)],
  ['API parses interpolation mode', /interpolationMode:[\s\S]*value\.interpolationMode === "neutral"/.test(api)],
  ['R2 cache key includes interpolation mode', /interpolationMode: point\.interpolationMode \?\? "los-safe"/.test(api)],
  ['R2 cache version bumped for persistent terrain results', /namespace: "gsi-elevation", version: "v3"/.test(api)],
  ['client transmits interpolation mode', /interpolationMode\?: "los-safe" \| "neutral"/.test(client)],
  ['neutral terrain sampler requests neutral GSI', /export async function sampleWorldTerrainNeutral[\s\S]*interpolationMode: "neutral" as const/.test(terrain)],
  ['tripod calculator defaults to neutral terrain sampler', /terrainSampler: TerrainSampler = sampleWorldTerrainNeutral/.test(tripod)],
  ['tripod imports no ordinary sampleWorldTerrain fallback as default', !/import \{ sampleWorldTerrain, terrainDataSource \}/.test(tripod)],
];
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) process.exitCode = 1;
}
