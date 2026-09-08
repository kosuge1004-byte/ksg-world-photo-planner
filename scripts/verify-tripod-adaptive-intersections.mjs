import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts',import.meta.url),'utf8');
const checks=[
 ['32-point seed preserved',/DEFAULT_SAMPLE_COUNT\s*=\s*32/],
 ['coarse densification capped at 30m',/ADAPTIVE_COARSE_MAX_SPAN_METERS\s*=\s*30/],
 ['near-ray adaptive span enabled',/ADAPTIVE_NEAR_RAY_MAX_SPAN_METERS\s*=\s*100/],
 ['coarse DEM sampling remains 10m',/sampleRayTerrainErrors\([\s\S]*?additions,[\s\S]*?"10m"/],
 ['final intersection refinement remains 1m',/refinementDistances,[\s\S]*?"1m"/],
 ['multi-intersection refinement is batched',/const requests: Array<\{ stateIndex: number; distance: number \}>[\s\S]*refinementDistances[\s\S]*sampleRayTerrainErrors/.test(source)],
 ['final altitude convergence checked',/finalAltitudeError\s*>\s*CONVERGED_HORIZONTAL_DEGREES/],
 ['final azimuth convergence checked',/finalAzimuthError\s*>\s*CONVERGED_HORIZONTAL_DEGREES/],
 ['camera FOV is not used to reject tripod candidates',/_previewAspectRatio/],
];
let failed=false; for(const item of checks){const [name,test]=item; const ok=typeof test==='boolean'?test:test.test(source); console.log(`${ok?'PASS':'FAIL'}: ${name}`); failed||=!ok;} process.exit(failed?1:0);
