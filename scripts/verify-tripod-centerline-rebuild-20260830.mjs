import fs from 'node:fs';
const s=fs.readFileSync('src/cesium/tripodCandidates.ts','utf8');
const checks=[
 ['obsolete centerline solver is absent',!s.includes('solveTripodCenterline')],
 ['authoritative path builds celestial backward ECEF ray',s.includes('buildCelestialBackwardRay')],
 ['candidate celestial position is recalculated',s.includes('const horizontal = calculateCelestialHorizontalCoordinates')],
 ['candidate weather is resolved before recomputation',s.includes('resolveCandidateWeather(candidatePoint)')],
 ['altitude residual is checked',s.includes('currentAltitudeError')],
 ['azimuth residual is checked',s.includes('currentAzimuthError')],
 ['final nonconvergence is rejected',s.includes('final-horizontal-not-converged')],
 ['legacy scanInitialRayTerrainIntersections seed is absent',!s.includes('scanInitialRayTerrainIntersections(')],
];
let n=0;for(const [m,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${m}`);if(!ok)n++;}if(n)process.exit(1);
