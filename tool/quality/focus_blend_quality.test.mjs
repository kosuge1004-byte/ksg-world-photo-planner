import test from 'node:test';
import assert from 'node:assert/strict';

function secondaryWeight(confidence, hard=.65, max=.45, difference=0, scale=4){
  const ambiguity=Math.max(0,Math.min(1,(hard-confidence)/hard));
  const atten=1/(1+scale*difference);
  return Math.max(0,Math.min(max,max*ambiguity*atten));
}

test('larger cross-frame mismatch decreases secondary contribution',()=>{
  const near=secondaryWeight(.1,.65,.45,.05,4);
  const far=secondaryWeight(.1,.65,.45,2.0,4);
  assert.ok(near>far);
});

test('high confidence produces zero secondary contribution',()=>{
  assert.equal(secondaryWeight(.9),0);
});
