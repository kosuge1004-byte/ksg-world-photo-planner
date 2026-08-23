import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const map = fs.readFileSync(new URL('../src/cesium/celestialMap.ts', import.meta.url), 'utf8');

const checks = [
  ['direction-only fallback imported', app.includes('buildDirectionalTripodCandidates')],
  ['direction-only candidates shown during precision calculation', /const directionalCandidates = buildDirectionalTripodCandidates\([\s\S]*setTripodCandidates\(directionalCandidates\);[\s\S]*setTripodCandidateCalculationStatus\("calculating"\)/.test(app)],
  ['zero precision solutions retain direction-only candidates', /const displayedCandidates = candidates\.length > 0[\s\S]*\? candidates[\s\S]*: directionalCandidates/.test(app)],
  ['terrain errors retain direction-only candidates', /setTripodCandidateCalculationStatus\("error"\)/.test(app) && /tripodCandidatesRef\.current = directionalCandidates;[\s\S]*setTripodCandidates\(directionalCandidates\);[\s\S]*setTripodCandidateCalculationStatus\("error"\)/.test(app)],
  ['3D candidate callback updates request a render', /function updateTripodCandidateEntities[\s\S]*viewer\.scene\.requestRender\(\);/.test(map)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
