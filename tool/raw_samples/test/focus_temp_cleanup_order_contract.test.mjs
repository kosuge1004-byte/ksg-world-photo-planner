import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const marking = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_marking_analysis_pipeline.dart', root),
  'utf8',
);
const stacking = fs.readFileSync(
  new URL('lib/core/focus_stack/focus_stack_pipeline.dart', root),
  'utf8',
);

test('marking RGB stores use best-effort reverse disposal after score cleanup', () => {
  assert.match(
    marking,
    /finally\s*\{\s*\/\/ Store disposal must still run[\s\S]*?try\s*\{[\s\S]*?scoreDirectory\.delete\(recursive:\s*true\);[\s\S]*?\}\s*finally\s*\{\s*await _disposeFocusRgbStoresBestEffort\(stores\.reversed,\s*cache: decodedFrameCache, discard: isCancelled\?\.call\(\) \?\? false\)/,
  );
  assert.match(marking, /for \(final LinearRgbTileStore store in stores\)[\s\S]*?await store\.dispose\(\)[\s\S]*?firstError \?\?= error/);
  assert.match(marking, /Error\.throwWithStackTrace\(firstError/);
});

test('stack decoded stores are disposed even if earlier temp cleanup fails', () => {
  assert.match(
    stacking,
    /finally\s*\{\s*final LinearRgbTileStore\? finalStore[\s\S]*?try\s*\{[\s\S]*?finalStore\.dispose\(\);[\s\S]*?\}\s*finally\s*\{[\s\S]*?scores\.delete\(recursive:\s*true\);[\s\S]*?\}\s*finally\s*\{[\s\S]*?decodedStores\.reversed/,
  );
});
