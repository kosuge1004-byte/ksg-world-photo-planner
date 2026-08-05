import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const worldTerrain = read('server/worldTerrain.ts');
const surface = read('server/surfaceObstructionLineOfSight.ts');
const adaptive = read('src/geodesy/adaptiveTerrainProfile.ts');

assert.match(worldTerrain, /const requests = new Map<string/);
assert.doesNotMatch(worldTerrain, /const waits: Array<Promise<void>>/);
assert.match(worldTerrain, /const samples = await Promise\.all/);
assert.match(surface, /featureName: string \| null/);
assert.doesNotMatch(surface, /candidates: Array<\{\s*tags:/);
assert.match(adaptive, /const distances = new Array<number>\(sampleCount\)/);
assert.match(adaptive, /const refined = new Array<number>\(sampleCount\)/);
console.log('Phase6-2 memory verification passed.');
