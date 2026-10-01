import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const validator = readFileSync(
  new URL('../../../lib/core/focus_stack/focus_stack_input_validator.dart', import.meta.url),
  'utf8',
);
const screen = readFileSync(
  new URL('../../../lib/features/focus_stack/focus_stack_screen.dart', import.meta.url),
  'utf8',
);

test('focus-stack input validator requires structural RAW compatibility', () => {
  assert.match(validator, /minimumInputCount = 2/);
  assert.match(validator, /probe\.format != referenceProbe\.format/);
  assert.match(validator, /metadata\.width != referenceMetadata\.width/);
  assert.match(validator, /metadata\.cfaPattern != referenceMetadata\.cfaPattern/);
  assert.match(validator, /ActiveArea/);
  assert.match(validator, /orientation/);
});

test('focus-stack input screen supports explicit ordering and duplicate-path suppression', () => {
  assert.match(screen, /known\.add\(file\.path\)/);
  assert.match(screen, /_move\(int from, int delta\)/);
  assert.match(screen, /keyboard_arrow_up_rounded/);
  assert.match(screen, /keyboard_arrow_down_rounded/);
  assert.match(screen, /近景→遠景でも遠景→近景でも/);
});

test('Work221 launches analysis only after validated RAW input', () => {
  assert.match(screen, /validation\.isValid && !busy \? onPressed : null/);
  assert.match(screen, /合焦位置を解析/);
  assert.match(screen, /_analyzeAndReview/);
});

test('Focus Stack exposes the production-decodable Sony and Nikon paths', () => {
  assert.match(screen, /allowedExtensions: const <String>\{'arw', 'nef', 'nrw'\}/);
  assert.match(screen, /createProductionNativeRawMetadataProbe\(\)/);
  assert.equal(
    (screen.match(/createProductionNativeRawDecoderRegistry\(\)/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(screen, /createNativeRawDecoderRegistry\(\)/);
});
