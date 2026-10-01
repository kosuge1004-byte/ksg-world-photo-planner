import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('demosaic support radius is an engine contract, not a global reference constant', () => {
  const api = readFileSync(new URL('../../../lib/core/demosaic/demosaic_engine.dart', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../../../lib/core/demosaic/native_mobile_stack_demosaic_engine.dart', import.meta.url), 'utf8');
  const reference = readFileSync(new URL('../../../lib/core/demosaic/mobile_stack_adaptive_demosaic_engine.dart', import.meta.url), 'utf8');
  assert.match(api, /int get requiredInputRadius/);
  assert.match(native, /nativeRequiredInputRadius\s*=\s*5/);
  assert.match(native, /int get requiredInputRadius => nativeRequiredInputRadius/);
  assert.match(reference, /referenceRequiredInputRadius\s*=\s*5/);
  assert.match(reference, /int get requiredInputRadius => referenceRequiredInputRadius/);
});
