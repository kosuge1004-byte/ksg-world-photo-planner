
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const writer = readFileSync(
  new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
  'utf8',
);
const metadata = readFileSync(
  new URL('../../../lib/core/raw/raw_decoder_contract.dart', import.meta.url),
  'utf8',
);
const abi = readFileSync(
  new URL('../../../native/include/mobile_stack_raw_ffi.h', import.meta.url),
  'utf8',
);

test('Linear DNG provenance contract does not invent representative exposure EXIF', () => {
  assert.match(writer, /class LinearDngProvenance/);
  assert.match(writer, /sourceFrameCount/);
  assert.doesNotMatch(writer, /representativeIso|representativeShutter|representativeAperture/);
});

test('current RawFrameMetadata does not yet expose capture EXIF fields', () => {
  const classStart = metadata.indexOf('class RawFrameMetadata');
  const classEnd = metadata.indexOf('final class RawProfileHueSatMap');
  const body = metadata.slice(classStart, classEnd);
  assert.doesNotMatch(body, /\biso\b/i);
  assert.doesNotMatch(body, /\bexposureTime\b/i);
  assert.doesNotMatch(body, /\bfNumber\b/i);
  assert.doesNotMatch(body, /\bfocalLength\b/i);
  assert.doesNotMatch(body, /\bdateTimeOriginal\b/i);
  assert.doesNotMatch(body, /\blensModel\b/i);
});

test('current native metadata ABI does not yet expose capture EXIF fields', () => {
  const structStart = abi.indexOf('typedef struct MobileStackRawMetadataProbeResult');
  const structEnd = abi.indexOf('} MobileStackRawMetadataProbeResult;');
  const body = abi.slice(structStart, structEnd);
  assert.doesNotMatch(body, /\biso\b/i);
  assert.doesNotMatch(body, /\bexposure_time\b/i);
  assert.doesNotMatch(body, /\bf_number\b/i);
  assert.doesNotMatch(body, /\bfocal_length\b/i);
  assert.doesNotMatch(body, /\bdate_time_original\b/i);
  assert.doesNotMatch(body, /\blens_model\b/i);
});
