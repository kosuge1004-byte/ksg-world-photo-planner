import test from 'node:test';
import assert from 'node:assert/strict';

function zncc(a,b){
  const ma=a.reduce((s,v)=>s+v,0)/a.length;
  const mb=b.reduce((s,v)=>s+v,0)/b.length;
  let n=0,ea=0,eb=0;
  for(let i=0;i<a.length;i++){
    const x=a[i]-ma,y=b[i]-mb;
    n+=x*y; ea+=x*x; eb+=y*y;
  }
  return n/Math.sqrt(ea*eb);
}
test('ZNCC is invariant to affine brightness scale and offset',()=>{
  const a=[0,1,2,3,2,1,0];
  const b=a.map(v=>5*v+17);
  assert.ok(Math.abs(zncc(a,b)-1)<1e-12);
});
