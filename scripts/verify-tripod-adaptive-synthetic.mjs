const MIN = 8;
const MAX = 50_000;
const COUNT = 32;
const MAX_SPAN = 500;
const NEAR_SPAN = 100;
const NEAR_ERROR = 0.12;
const CAP = 640;

function logDistances() {
  const ratio = MAX / MIN;
  return Array.from({ length: COUNT }, (_, i) => MIN * ratio ** (i / (COUNT - 1)));
}
function unique(values) {
  return values.slice().sort((a,b)=>a-b).filter((v,i,a)=>i===0 || Math.abs(v-a[i-1])>=0.01);
}
function densify(distances, span) {
  const out=[distances[0]];
  for (let i=1;i<distances.length;i++) {
    const lo=distances[i-1], hi=distances[i], width=hi-lo;
    const segments=Math.max(1,Math.ceil(width/span));
    for(let s=1;s<=segments;s++) out.push(lo+width*s/segments);
  }
  return unique(out);
}
function brackets(distances, fn) {
  const e=distances.map(fn); let n=0;
  for(let i=1;i<e.length;i++) if (e[i-1]===0 || e[i]===0 || e[i-1]*e[i]<0) n++;
  return n;
}
// 32点対数走査の遠距離側の1区間内部に、約700m幅で+→-→+となる人工地形を置く。
const base=logDistances();
let targetPair=null;
for(let i=1;i<base.length;i++) {
  if(base[i]-base[i-1] > 1200) { targetPair=[base[i-1],base[i]]; break; }
}
if(!targetPair) throw new Error('wide interval not found');
const center=(targetPair[0]+targetPair[1])/2;
const halfWidth=350;
const synthetic=(d)=>((d-(center-halfWidth))*(d-(center+halfWidth)))/1_000_000;
const baseBrackets=brackets(base,synthetic);
const coarse=densify(base,MAX_SPAN);
const coarseBrackets=brackets(coarse,synthetic);

console.log(`${baseBrackets===0?'PASS':'FAIL'}: baseline 32-point scan misses synthetic double crossing`);
console.log(`${coarseBrackets>=2?'PASS':'FAIL'}: 500m batched densification detects synthetic double crossing (${coarseBrackets} brackets)`);
console.log(`${coarse.length<=CAP?'PASS':'FAIL'}: coarse adaptive sample count ${coarse.length} <= ${CAP}`);
console.log(`INFO: baseline=${base.length}, coarse=${coarse.length}, maxSpan=${Math.max(...coarse.slice(1).map((v,i)=>v-coarse[i])).toFixed(1)}m`);
if(baseBrackets!==0 || coarseBrackets<2 || coarse.length>CAP) process.exit(1);
