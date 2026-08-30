import fs from 'node:fs';
const text = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const checks = [
  ['stable confirmed ref exists', /lastConfirmedTripodCandidatesRef = useRef<TripodCandidate\[\]>/],
  ['stable subject ref exists', /lastConfirmedTripodSubjectRef = useRef/],
  ['drag projection uses stable confirmed ref', /for \(const candidate of lastConfirmedTripodCandidatesRef\.current\)/],
  ['same subject reuse gate exists', /const canReuseLastConfirmed =/],
  ['preferred distance uses stable ref', /\? lastConfirmedTripodCandidatesRef\.current\.reduce/],
  ['same subject keeps candidates while refining', /if \(!canReuseLastConfirmed\)[\s\S]{0,400}else \{[\s\S]{0,200}lastConfirmedTripodCandidatesRef\.current/],
  ['final result refreshes stable ref', /lastConfirmedTripodCandidatesRef\.current = displayedCandidates/],
  ['reset clears stable ref', /clearPersistentTripodSeeds\(\)[\s\S]{0,250}lastConfirmedTripodCandidatesRef\.current = \[\]/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(text); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++;
}
if (failed) process.exit(1);
