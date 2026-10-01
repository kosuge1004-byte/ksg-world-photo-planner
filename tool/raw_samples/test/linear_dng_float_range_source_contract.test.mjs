import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../../lib/core/export/linear_dng_writer.dart', import.meta.url),
  'utf8',
);

test('Float32 LinearRaw uses DNG-defined BlackLevel 0 and WhiteLevel 1.0 defaults', () => {
  assert.equal((source.match(/writeEntry\(50714,/g) ?? []).length, 0,
    'BlackLevel permits SHORT/LONG/RATIONAL only; calibrated zero-black output should use the defined default 0');
  assert.equal((source.match(/writeEntry\(50717,/g) ?? []).length, 0,
    'WhiteLevel is SHORT/LONG-only in DNG; Float LinearRaw should use its defined 1.0 default');
  assert.match(source, /BlackLevel is omitted: the DNG-defined default is 0/);
});

test('Linear DNG reserves highlight headroom with exact power-of-two placement', () => {
  assert.match(source, /_analyzeLinearDngForExport/);
  assert.match(source, /math\.log\(maximum\) \/ math\.ln2/);
  assert.match(source, /math\.pow\(2\.0, headroomEv\)/);
  assert.match(source, /value \/ headroomScale/);
  assert.equal((source.match(/writeEntry\(50730,\s*signedRationalType,\s*1,\s*baselineExposureOffset\)/g) ?? []).length, 2);
  assert.match(source, /setInt32\(baselineExposureOffset, baselineExposureEv/);
  assert.match(source, /_linearDngDefaultRenderBaselineExposureEv = 0/);
  assert.equal(
    (source.match(/baselineExposureEv: _linearDngDefaultRenderBaselineExposureEv/g) ?? []).length,
    2,
    'Classic TIFF and BigTIFF exports must not reinterpret raw-domain normalization as Adobe display exposure',
  );
});

test('Linear DNG export rejects non-finite and Float32-overflow samples', () => {
  assert.match(source, /non-finite sample/);
  assert.match(source, /exceeds finite Float32 range/);
});


test('Linear DNG storage preserves finite negative scene-linear samples instead of clamping them', () => {
  assert.match(source, /encodedData\.setFloat32\([\s\S]*value \/ headroomScale/);
  assert.doesNotMatch(source, /value\.clamp\(0(?:\.0)?,\s*1(?:\.0)?\)/);
  assert.doesNotMatch(source, /math\.max\(0(?:\.0)?,\s*value\)/);
  assert.match(source, /DefaultBlackRender = None/);
});
