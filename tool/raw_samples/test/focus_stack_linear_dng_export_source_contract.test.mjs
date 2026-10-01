import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipeline=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_pipeline.dart',import.meta.url),
  'utf8',
);
const exporter=readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_linear_dng_export.dart',import.meta.url),
  'utf8',
);

test('focus stack requires explicit color matrix and white-balance metadata',()=>{
  assert.match(pipeline,/_requireOutputColorMetadata/);
  assert.match(pipeline,/d65XyzToCamera == null/);
  assert.match(pipeline,/cameraWhiteBalance == null/);
});

test('selected frame camera matrices must be compatible rather than averaged',()=>{
  assert.match(pipeline,/abs\(\) > 1e-5/);
  assert.match(pipeline,/incompatible camera color matrices/);
  assert.doesNotMatch(pipeline,/average.*matrix|mean.*matrix/i);
});

test('Linear DNG export applies one reference-frame color transform at serialization',()=>{
  assert.match(exporter,/RawCameraColorProfile/);
  assert.match(exporter,/profile\.outputTransform\(result\.cfaPattern\)/);
  assert.match(exporter,/exportTileStoreToLinearDng/);
  assert.doesNotMatch(exporter,/applyLinearRgbColorTransformTiled/);
});

test('focus-stack coverage is exported as binary transparency mask without a full-size duplicate',()=>{
  assert.match(exporter,/transparencyMaskSource: result\.coverageMask/);
  assert.doesNotMatch(exporter,/Uint8List\s*\(\s*result\.coverage\.length\s*\)/);
});

test('focus result carries CFA pattern needed for reference WB interpretation',()=>{
  assert.match(pipeline,/final CfaPattern cfaPattern/);
  assert.match(pipeline,/referenceCfaPattern = decoded\.mosaic\.cfaPattern/);
  assert.match(pipeline,/cfaPattern: referenceCfaPattern!/);
  assert.doesNotMatch(pipeline,/List<RawDecodeResult>\s+decodedFrames/);
});
