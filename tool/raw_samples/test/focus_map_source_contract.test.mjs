import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const measure=readFileSync(new URL('../../../lib/core/focus_stack/focus_measure.dart',import.meta.url),'utf8');
const winner=readFileSync(new URL('../../../lib/core/focus_stack/focus_winner_map.dart',import.meta.url),'utf8');

test('focus metric uses linear signed second derivatives with direct Float64 integral accumulation',()=>{
  assert.match(measure,/left - 2 \* center \+ right/);
  assert.match(measure,/up - 2 \* center \+ down/);
  assert.match(measure,/Float64List integral/);
  assert.match(measure,/rowSum \+= response/);
  assert.doesNotMatch(measure,/Float64List response\s*=/);
  assert.doesNotMatch(measure,/gamma|tone curve/i);
});
test('winner map retains winner index and confidence',()=>{
  assert.match(winner,/Int32List frameIndices/);
  assert.match(winner,/Float32List confidence/);
  assert.match(winner,/\(best - second\) \/ best/);
});
