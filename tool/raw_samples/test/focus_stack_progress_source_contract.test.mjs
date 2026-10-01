import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_pipeline.dart',import.meta.url),
  'utf8',
);

test('focus-stack progress partitions demosaic before alignment without backward jumps',()=>{
  assert.match(source,/0\.45 \* \(index \+ p\) \/ inputs\.length/);
  assert.match(source,/0\.45 \+ 0\.12 \* \(index \+ 1\) \/ inputs\.length/);
  assert.match(source,/0\.57 \+ 0\.23 \* \(index \+ 1\) \/ inputs\.length/);
  assert.match(source,/fraction: 0\.88/);
  assert.match(source,/fraction: 1/);
});
