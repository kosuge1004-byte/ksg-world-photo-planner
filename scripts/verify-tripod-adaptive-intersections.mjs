import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const checks = [
  ['32-point seed preserved', /DEFAULT_SAMPLE_COUNT\s*=\s*32/],
  ['coarse adaptive span enabled', /ADAPTIVE_COARSE_MAX_SPAN_METERS\s*=\s*500/],
  ['near-ray adaptive span enabled', /ADAPTIVE_NEAR_RAY_MAX_SPAN_METERS\s*=\s*100/],
  ['coarse scan remains 10m', /sampleTerrainErrors\([\s\S]*?distances,[\s\S]*?"10m"/],
  ['final intersection refinement remains 1m', /refinementDistances,[\s\S]*?"1m"/],
  ['multi-intersection refinement is batched', /複数交点を1個ずつ逐次DEM取得せず/],
  ['final altitude convergence checked', /finalAltitudeError\s*>\s*CONVERGED_HORIZONTAL_DEGREES/],
  ['final azimuth convergence checked', /finalAzimuthError\s*>\s*CONVERGED_HORIZONTAL_DEGREES/],
  ['camera FOV is not used to reject tripod candidates', /_previewAspectRatio/],
];
let failed = false;
for (const [name, regex] of checks) {
  const ok = regex.test(source);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
