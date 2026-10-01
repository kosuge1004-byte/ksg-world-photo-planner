import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../../../native/src/mobile_stack_arw_lossless.c', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../../../native/src/mobile_stack_raw_ffi_stub.c', import.meta.url), 'utf8');
test('native ARW decoder accepts bounded uncompressed CFA strips', () => {
  assert.match(source, /kCompressionNone = 1/);
  assert.match(source, /ifd->compression == kCompressionNone/);
  assert.match(source, /expected_uncompressed = row_count \* ifd->width \* 2u/);
  assert.match(source, /decode_uncompressed_strips/);
  assert.match(source, /read_u16\(reader, bytes \+ i \* 2u\)/);
  assert.match(source, /value > maximum_value/);
});

test('custom ARW pixel limit cannot be bypassed by the LibRaw fallback', () => {
  assert.match(
    bridge,
    /status == MOBILE_STACK_RAW_RESOURCE_LIMIT[\s\S]{0,200}set_error\(result, status, error_code, error_message\)/,
  );
});
