import fs from 'node:fs';
const p='src/cesium/tripodCandidates.ts';
const s=fs.readFileSync(p,'utf8');
const checks=[
  ['final helper accepts sampled fallback', /sampledGeoidFallback\?: number/],
  ['mapped geoid preferred', /const mappedGeoid = geoidHeightMetersForTerrainSample\(cartographic\)/],
  ['fallback used when WeakMap metadata is lost', /Number\.isFinite\(sampledGeoidFallback\) \? sampledGeoidFallback : undefined/],
  ['best candidate geoid propagated', /best\.candidatePoint\.geoidHeightMeters/],
  ['point-specific geoid remains authoritative when available', /const geoidForEllipsoidal = exactGeoid \?\? geoidForOrthometric/],
  ['no hardcoded geoid correction', /const sampledGeoid = Number\.isFinite\(mappedGeoid\)/],
];
let n=0;
for (const [name,re] of checks){
  if(!re.test(s)){console.error('FAIL:',name);process.exitCode=1;} else {console.log('PASS:',name);n++;}
}
if(!process.exitCode) console.log(`PASS ${n}/${checks.length}`);
