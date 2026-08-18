import fs from 'node:fs';
const source = fs.readFileSync(new URL('../server/surfaceObstructionLineOfSight.ts', import.meta.url), 'utf8');
const osm = fs.readFileSync(new URL('../server/osmSiteContext.ts', import.meta.url), 'utf8');
const checks = [
  ['feature DEM lookup', source.includes('lookupGsiElevations') && source.includes('featureGroundMeters')],
  ['height provenance', source.includes('heightSource?:') && source.includes('groundElevationSource?:')],
  ['height priority', osm.includes('mappedHeight ??') && osm.includes('levels * METERS_PER_BUILDING_LEVEL')],
  ['bounded batch', source.includes('candidates.length >= 2_048')],
  ['fallback ground', source.includes('sample?.heightMeters ?? origin.groundElevationMeters')],
];
let failed = false;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed = true; }
if (failed) process.exit(1);
