import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('LibRaw registers Sony ILCE-7M5 with the upstream camera ID and color matrix', () => {
  assert.match(
    read('native/third_party/libraw/internal/libraw_cameraids.h'),
    /SonyID_ILCE_7M5\s+0x197ULL/,
  );
  assert.match(
    read('native/third_party/libraw/src/metadata/normalize_model.cpp'),
    /SonyID_ILCE_7M5,\s+"ILCE-7M5"/,
  );
  assert.match(
    read('native/third_party/libraw/src/tables/colordata.cpp'),
    /"ILCE-7M5"[\s\S]*?9089,\s*-3577,\s*-787,\s*-3563,\s*11326,\s*2557,\s*-114,\s*928,\s*5904/,
  );
});

test('LibRaw dispatches Sony TIFF compression 32766 to the ARW 6 decoder', () => {
  const tiff = read('native/third_party/libraw/src/metadata/tiff.cpp');
  assert.match(tiff, /case 32766:[\s\S]*?sony_arw6_load_raw/);
  assert.match(tiff, /phint == 32803/);
  assert.match(tiff, /samples == 1/);
  assert.match(tiff, /tiff_bps == 12 \|\| tiff_bps == 14/);

  const declarations = read(
    'native/third_party/libraw/internal/libraw_internal_funcs.h',
  );
  assert.match(declarations, /void\s+sony_arw6_load_raw\(\);/);
  assert.match(
    read('native/third_party/libraw/src/decoders/sony_arw6.cpp'),
    /void LibRaw::sony_arw6_load_raw\(\)/,
  );
});

test('ARW 6 decoded levels match the upstream transfer curve contract', () => {
  const source = read('native/third_party/libraw/src/utils/open.cpp');
  const arw6 = source.slice(source.indexOf('sony_arw6_load_raw'));
  assert.match(arw6, /C\.black = 1024/);
  assert.match(arw6, /C\.maximum = 39002/);
  assert.match(arw6, /C\.linear_max\[c\] = 32800/);
});

test('Android release optimization for the large ARW 6 unit stays memory-bounded', () => {
  const cmake = read('native/cmake/libraw.cmake');
  assert.match(cmake, /sony_arw6\.cpp/);
  assert.match(cmake, /CONFIG:Release>:-O2/);
});
