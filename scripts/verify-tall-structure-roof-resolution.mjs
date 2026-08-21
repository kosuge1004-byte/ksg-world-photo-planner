import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = path.join(root, 'src/cesium/plateauBuildingVerification.ts');
const source = fs.readFileSync(file, 'utf8');

const match = source.match(/const MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS = (\d+(?:\.\d+)?);/);
if (!match) throw new Error('MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS not found');
const maxHeight = Number(match[1]);

const cases = [
  ['ordinary building 80m', 80, true],
  ['Tokyo Tower 333m', 333, true],
  ['Tokyo Skytree 634m', 634, true],
  ['negative surface', -1, false],
  ['gross invalid height 1500m', 1500, false],
];

for (const [name, height, expected] of cases) {
  const accepted = Number.isFinite(height) && height >= 0 && height <= maxHeight;
  if (accepted !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${accepted} (max=${maxHeight})`);
  }
  console.log(`PASS: ${name}`);
}

if (source.includes('GROSS_MISALIGNMENT_TOLERANCE_METERS = 120')) {
  throw new Error('legacy 120m roof cutoff still exists');
}
if (!source.includes('roofAboveGroundMeters > MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS')) {
  throw new Error('new tall-structure validation is not wired into clampAndValidate');
}
console.log(`PASS: tall-structure roof limit is ${maxHeight}m and wired into validation`);
