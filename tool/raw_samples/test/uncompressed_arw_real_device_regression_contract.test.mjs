import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../../../', import.meta.url);
const source = fs.readFileSync(new URL('integration_test/real_uncompressed_arw_pipeline_test.dart', root), 'utf8');
test('real-device uncompressed ARW regression gate exists', () => {
  assert.match(source, /MOBILE_STACK_UNCOMPRESSED_ARW_PATH/);
  assert.match(source, /FfiRawNativeBridge\.openForCurrentPlatform/);
  assert.match(source, /expectedFormat:\s*RawFormat\.arw/);
  assert.match(source, /frame\.samples\.every\(\(double v\) => v\.isFinite\)/);
  assert.match(source, /v >= 0 && v <= frame\.whiteLevel/);
});
