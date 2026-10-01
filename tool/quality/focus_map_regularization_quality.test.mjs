import test from 'node:test';
import assert from 'node:assert/strict';

function weightedMedian(values){
  const s=[...values].sort((a,b)=>a.label-b.label);
  const total=s.reduce((x,v)=>x+v.weight,0);
  let c=0;
  for(const v of s){c+=v.weight;if(c>=total*.5)return v.label;}
  return s.at(-1).label;
}

test('ordinal weighted median always returns an observed label',()=>{
  const values=[
    {label:0,weight:.2},
    {label:4,weight:.6},
    {label:7,weight:.2},
  ];
  const result=weightedMedian(values);
  assert.equal(result,4);
  assert.ok(values.some(v=>v.label===result));
});
