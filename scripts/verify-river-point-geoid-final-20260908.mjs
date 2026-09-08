import fs from 'node:fs';
const t=fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url),'utf8');
const checks=[
 ['river keeps nearest-land orthometric H before exact N', t.includes('nearestLand.orthometricHeightMeters + geoidForCandidate')],
 ['river builds candidate cartographic at sampled datum', t.includes('const riverCandidateCartographic = Cartographic.fromRadians')],
 ['river final path uses point-specific geoid helper', /buildPointSpecificFinalCandidateGroundPoint\(\s*riverCandidateCartographic/.test(t)],
 ['river passes sampled candidate N only as fallback', /riverCandidateCartographic,[\s\S]{0,250}geoidForCandidate,[\s\S]{0,100}trace/.test(t)],
];
let fail=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${n}`); if(!ok) fail++;} process.exitCode=fail?1:0;
