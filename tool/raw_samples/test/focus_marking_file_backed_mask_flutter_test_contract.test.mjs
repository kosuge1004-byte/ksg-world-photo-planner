import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const dartTest = fs.readFileSync(
  new URL('test/high_precision_focus_marking_test.dart', root),
  'utf8',
);
const workflow = fs.readFileSync(
  new URL('.github/workflows/native-raw-abi.yml', root),
  'utf8',
);

test('Flutter regression compares file-backed and resident coverage masks', () => {
  assert.match(dartTest, /file-backed coverage masks are exactly equivalent to resident masks/);
  assert.match(dartTest, /validMasks:\s*masks/);
  assert.match(dartTest, /validMaskFiles:\s*maskFiles/);
  assert.match(dartTest, /orderedEquals\(resident\.confidence\)/);
  assert.match(dartTest, /orderedEquals\(resident\.frameMasks\[frame\]\)/);
  assert.match(dartTest, /orderedEquals\(resident\.coverageFractions\)/);
});

test('CI still requires Flutter tests', () => {
  assert.match(workflow, /- name: Run Dart unit tests[\s\S]*?run:\s*flutter test/);
});
