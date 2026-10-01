import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('bundles the pinned LibRaw source and both upstream license choices', () => {
  assert.ok(existsSync(new URL('native/third_party/libraw/LICENSE.CDDL', root)));
  assert.ok(existsSync(new URL('native/third_party/libraw/LICENSE.LGPL', root)));
  assert.match(read('native/third_party/libraw/Changelog.txt'), /0\.22\.2/);
  assert.match(read('native/THIRD_PARTY_NOTICES.md'), /selects the CDDL 1\.0 option/);
});

test('keeps the Work245 Sony decoder first and dispatches Nikon through LibRaw', () => {
  const source = read('native/src/mobile_stack_raw_ffi_stub.c');
  assert.ok(
    source.indexOf('mobile_stack_arw_decode_lossless') <
      source.indexOf('mobile_stack_libraw_decode'),
  );
  assert.match(source, /MOBILE_STACK_RAW_FORMAT_NEF/);
  assert.match(source, /MOBILE_STACK_RAW_FORMAT_NRW/);
  assert.match(source, /MOBILE_STACK_RAW_CAPABILITY_LIBRAW_SONY/);
  assert.match(source, /MOBILE_STACK_RAW_CAPABILITY_LIBRAW_NIKON/);
});

test('LibRaw wrapper copies preserved sensor samples without post-processing', () => {
  const wrapper = read('native/src/mobile_stack_libraw.cpp');
  assert.match(wrapper, /processor->open_file/);
  assert.match(wrapper, /processor->unpack\(\)/);
  assert.match(wrapper, /target\[column\] = static_cast<float>\(source\[column\]\)/);
  assert.doesNotMatch(wrapper, /dcraw_process|dcraw_make_mem_image|raw2image/);
  assert.match(wrapper, /Only single-plane 2x2 Bayer Sony\/Nikon RAW files are supported/);
});

test('production Dart registry exposes only Sony ARW and Nikon NEF/NRW', () => {
  const factory = read('lib/core/raw/native_raw_decoder_factory.dart');
  const production = factory.slice(
    factory.indexOf('productionSonyNikonRawFormats'),
    factory.indexOf('RawDecoderRegistry createProductionNativeRawDecoderRegistry'),
  );
  assert.match(production, /RawFormat\.arw/);
  assert.match(production, /RawFormat\.nef/);
  assert.match(production, /RawFormat\.nrw/);
  assert.doesNotMatch(production, /RawFormat\.cr|RawFormat\.dng|RawFormat\.raf/);
  assert.match(factory, /mobile-stack-native-sony-nikon-libraw-v3/);
});

test('hash-pinned manifest distinguishes verified decode from exclusions', () => {
  const manifest = JSON.parse(read('SONY_NIKON_RAW_VERIFICATION_MANIFEST.json'));
  const verified = manifest.sourceCorpus.samples.filter(
    (sample) => sample.status === 'VERIFIED_DECODE',
  );
  assert.equal(verified.length, 18);
  assert.ok(verified.every((sample) => /^[0-9a-f]{64}$/.test(sample.sha256)));
  assert.ok(verified.every((sample) => sample.width * sample.height > 0));
  assert.ok(manifest.sourceCorpus.samples.some(
    (sample) => sample.model === 'Z 8' && sample.status === 'UNSUPPORTED',
  ));
  assert.ok(manifest.sourceCorpus.samples.some(
    (sample) => sample.model === 'Z f' &&
      sample.rawMode === 'Lossless compressed' &&
      sample.status === 'VERIFIED_DECODE' &&
      sample.sha256 === '83c82be0be8865d796096dfbcc8ef2abf5af1bd37db44dfad6715070b0c99d15',
  ));
  assert.ok(manifest.sourceCorpus.samples.some(
    (sample) => sample.model === 'Z f' && sample.status === 'UNSUPPORTED',
  ));
  assert.ok(manifest.sourceCorpus.samples.some(
    (sample) => sample.brand === 'Sony' && sample.status === 'UNSUPPORTED',
  ));
});

test('broad matrices preserve SAMPLE_MISSING instead of claiming model-list verification', () => {
  const sony = read('SONY_RAW_COMPATIBILITY_MATRIX.csv');
  const nikon = read('NIKON_RAW_COMPATIBILITY_MATRIX.csv');
  assert.match(sony, /Sony,ILCE-7M4 \(A7 IV\).*VERIFIED_DECODE/);
  assert.match(sony, /Sony,ILCE-7M5 \(A7 V\).*VERIFIED_DECODE/);
  assert.match(nikon, /Nikon,Z 8,NEF,Lossless compressed,14.*VERIFIED_DECODE/);
  assert.match(nikon, /Nikon,Z f,NEF,Lossless compressed,14.*VERIFIED_DECODE/);
  assert.match(sony, /SAMPLE_MISSING/);
  assert.match(nikon, /SAMPLE_MISSING/);
});
