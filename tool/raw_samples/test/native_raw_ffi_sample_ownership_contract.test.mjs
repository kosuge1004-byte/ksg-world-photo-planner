import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const bridge = fs.readFileSync(
  new URL('lib/core/raw/ffi_raw_native_bridge.dart', root),
  'utf8',
);
const native = fs.readFileSync(
  new URL('native/src/mobile_stack_raw_ffi_stub.c', root),
  'utf8',
);

test('Dart RAW samples either transfer native ownership or copy before release', () => {
  assert.match(
    bridge,
    /if \(takeSampleOwnership\)[\s\S]*takeSamples\(resultPointer\)[\s\S]*_FfiRawSampleLease/,
  );
  assert.match(
    bridge,
    /nativeSamples = Float32List\.fromList\(\s*result\.samples\.asTypedList\(result\.sampleCount\),?\s*\)/s,
  );
  assert.match(bridge, /else \{[\s\S]*Float32List\.fromList\(/);
});

test('native result release really frees the sensor sample allocation', () => {
  assert.match(
    native,
    /mobile_stack_raw_decode_result_release[\s\S]*?free\(\(void\*\)result->samples\);/,
  );
});
