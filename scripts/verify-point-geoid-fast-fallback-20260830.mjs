import fs from 'node:fs';
const t=fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url),'utf8');
const w=fs.readFileSync(new URL('../src/cesium/worldTerrain.ts', import.meta.url),'utf8');
const checks=[
 ['fallback時1.2秒', t.includes('hasSampleFallback ? 1_200 : 15_000')],
 ['fallback不能時15秒維持', t.includes('hasSampleFallback ? 1_200 : 15_000')],
 ['sample Nを引継ぎ', t.includes('best.candidatePoint.geoidHeightMeters')],
 ['地点別成功を優先', t.includes('const geoidForEllipsoidal = exactGeoid ?? geoidForOrthometric')],
 ['point開始trace', t.includes('geoid:point:start')],
 ['point成功trace', t.includes('geoid:point:end')],
 ['fallback trace', t.includes('geoid:point:fallback')],
 ['timeout引数伝播', w.includes('fetchGsiGeoidHeightOnce(latitude, longitude, signal, true, timeoutMs)')],
 ['親Abortは維持', t.includes('isAbortError(error) && signal?.aborted')],
];
let fail=0; for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${n}`); if(!ok) fail++;} process.exitCode=fail?1:0;
