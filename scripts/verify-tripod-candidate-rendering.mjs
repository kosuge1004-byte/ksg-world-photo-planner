import fs from 'node:fs';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const map = fs.readFileSync(new URL('../src/cesium/celestialMap.ts', import.meta.url), 'utf8');

const checks = [
  ['I/O-free preliminary candidate builder imported', app.includes('buildPreliminaryTripodCandidates')],
  ['preliminary candidates shown before precision calculation starts', /const immediatePreliminaryCandidates = buildPreliminaryTripodCandidates\([\s\S]*setPreliminaryTripodCandidates\([\s\S]*setTripodCandidateCalculationStatus\("calculating"\)/.test(app)],
  ['zero precision solutions retain unconfirmed preliminary candidates', /const confirmedIds = new Set\([\s\S]*setPreliminaryTripodCandidates\(\(current\) => Object\.fromEntries\([\s\S]*!confirmedIds\.has/.test(app)],
  ['terrain errors leave preliminary candidates visible', /既に表示できた概算候補は消さない[\s\S]*setTripodCandidateCalculationStatus\("error"\)/.test(app)],
  ['completed celestial bodies publish candidates progressively', /\(resolvedId, resolvedCandidates\) =>[\s\S]*setTripodCandidates\(\(current\)/.test(app)],
  ['3D candidate callback updates request a render', /function updateTripodCandidateEntities[\s\S]*viewer\.scene\.requestRender\(\);/.test(map)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
