import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const arw = readFileSync(
  new URL('../../../native/src/mobile_stack_arw_lossless.c', import.meta.url),
  'utf8',
);
const bridge = readFileSync(
  new URL('../../../native/src/mobile_stack_raw_ffi_stub.c', import.meta.url),
  'utf8',
);
const nativeTest = readFileSync(
  new URL(
    '../../../native/tests/mobile_stack_arw_lossless_test.c',
    import.meta.url,
  ),
  'utf8',
);

test('Sony ARW model is parsed from the TIFF Model tag', () => {
  assert.match(arw, /kTagModel = 0x0110/);
  assert.match(arw, /case kTagModel:[\s\S]*read_ascii/);
  assert.match(arw, /inherited_camera_model/);
});

test('ILCE-7M3 receives its exact published D65 XYZ-to-camera matrix only', () => {
  assert.match(arw, /strcmp\(sensor->camera_model, "ILCE-7M3"\) != 0/);
  assert.match(
    arw,
    /0\.7374f, -0\.2389f, -0\.0551f,[\s\S]*-0\.5435f,\s+1\.3162f,\s+0\.2519f,[\s\S]*-0\.1006f,\s+0\.1795f,\s+0\.6552f/,
  );
  assert.doesNotMatch(arw, /ILCE-[^7]/);
});

test('ARW color matrix is forwarded through the native metadata ABI', () => {
  assert.match(
    bridge,
    /result->has_d65_xyz_to_camera = metadata\.has_d65_xyz_to_camera/,
  );
  for (let index = 0; index < 9; index += 1) {
    assert.match(
      bridge,
      new RegExp(
        `result->d65_xyz_to_camera_${index} = metadata\\.d65_xyz_to_camera\\[${index}\\]`,
      ),
    );
  }
});

test('native coverage proves the known matrix and rejects unknown fallback', () => {
  assert.match(nativeTest, /has_d65_xyz_to_camera == 1u/);
  assert.match(nativeTest, /check_unknown_model_has_no_color_matrix/);
  assert.match(nativeTest, /has_d65_xyz_to_camera == 0u/);
});
