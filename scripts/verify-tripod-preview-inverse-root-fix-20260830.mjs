import fs from 'node:fs';
const s=fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const checks=[
 ['old apparent-preview seed is absent',!s.includes('const apparentSeed =')],
 ['old centerline seed kind is absent',!s.includes('seedKind')],
 ['initial ray uses preview apparent altitude correction',s.includes('point.altitudeDegrees') && s.includes('groundRefraction')],
 ['candidate lens observer is rebuilt',s.includes('candidateLensObserver') && s.includes('withLensCenterHeight')],
 ['candidate celestial is recomputed',s.includes('const horizontal = calculateCelestialHorizontalCoordinates')],
 ['refined ECEF ray is rebuilt',s.includes('buildCelestialBackwardRay')],
 ['final horizontal convergence gate exists',s.includes('final-horizontal-not-converged')],
];
let n=0;for(const [m,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${m}`);if(!ok)n++;}if(n)process.exit(1);
