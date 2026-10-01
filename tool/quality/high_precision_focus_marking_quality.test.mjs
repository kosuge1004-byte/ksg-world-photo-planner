import test from 'node:test';
import assert from 'node:assert/strict';

function median(values){
  const s=[...values].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
}

test('multi-scale median rejects a single extreme scale spike',()=>{
  assert.equal(median([1000,.01,.01]),.01);
  assert.equal(median([4,4,4]),4);
});
