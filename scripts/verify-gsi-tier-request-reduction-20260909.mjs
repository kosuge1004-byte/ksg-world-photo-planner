import fs from 'node:fs';
const s = fs.readFileSync(new URL('../server/gsiElevation.ts', import.meta.url), 'utf8');
const checks = [
  ['DEM1A remains first authoritative tier', s.includes('const [firstSource, ...remainingSources] = GSI_TILE_SOURCES') && s.includes('applyResolved(await resolveSourceTier(firstSource, unresolved))')],
  ['5m sources grouped separately', s.includes('fiveMeterSources') && s.includes('source.label !== "DEM10B"')],
  ['DEM5A is resolved before lower 5m fallbacks', s.includes('applyResolved(await resolveSourceTier(dem5aSource, new Set(unresolved)))')],
  ['DEM5B/DEM5C may run in parallel after DEM5A', s.includes('Promise.all(\n        lowerFiveMeterSources.map((source) => resolveSourceTier(source, targetIndices))')],
  ['DEM10B delayed until unresolved remain', s.includes('if (unresolved.size > 0 && tenMeterSource)')],
  ['DEM10B only receives unresolved points', s.includes('resolveSourceTier(tenMeterSource, new Set(unresolved))')],
  ['source priority list unchanged', /DEM1A[\s\S]*DEM5A[\s\S]*DEM5B[\s\S]*DEM5C[\s\S]*DEM10B/.test(s)],
  ['constrained bicubic retained', s.includes('"constrained-bicubic"') && s.includes('heightFromNeighborhood(')],
];
let failed=0;
for (const [name, ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) failed++; }
if (failed) process.exit(1);
console.log(`PASS ${checks.length}/${checks.length}`);
