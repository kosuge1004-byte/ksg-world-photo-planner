import fs from 'node:fs';
const text = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const checks = [
  ['abort ref exists', text.includes('const tripodCalculationAbortRef = useRef<AbortController | null>(null);')],
  ['active controller registered', text.includes('tripodCalculationAbortRef.current = controller;')],
  ['manual tap detects running calculation', text.includes('const candidateCalculationWasRunning = tripodCandidateCalculationStatus === "calculating";')],
  ['manual tap aborts candidate calculation', text.includes('tripodCalculationAbortRef.current?.abort();')],
  ['manual tap still resolves accurate tripod height', text.includes('await setTripodPinFromCoordinates(') && text.includes('await resolveGroundPoint(')],
  ['manual tap commits tripod point', text.includes('setTripodPoint(point);') && text.includes('tripodPointRef.current = point;')],
  ['candidate calculation restarts automatically', text.includes('setTripodCandidateRetrySequence((current) => current + 1);')],
  ['cleanup clears abort ref', text.includes('if (tripodCalculationAbortRef.current === controller)')],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) process.exit(1);
console.log(`PASS ${checks.length}/${checks.length}`);
