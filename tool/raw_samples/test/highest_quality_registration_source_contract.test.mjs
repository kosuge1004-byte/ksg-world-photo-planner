import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
  'utf8',
);

test('large Milky Way registration bounds its detection plane without scaling output pixels', () => {
  assert.match(source, /maximumRegistrationPixels = 16 \* 1024 \* 1024/);
  assert.match(source, /\? 2\s*: 1/);
  assert.doesNotMatch(source, /maximumPreviewDimension = 3072/);
  assert.match(source, /final int previewWidth = \(store\.width \+ scale - 1\) ~\/ scale/);
  assert.match(source, /x: \(star\.x \+ 0\.5\) \* scale - 0\.5/);
});

test('saturation-influenced stars are filtered from the actual detected list', () => {
  assert.match(
    source,
    /for \(final DetectedStar star in sensorCoordinateStars\)/,
  );
  assert.doesNotMatch(
    source,
    /for \(final DetectedStar star in usablePreviewStars\)/,
  );
});

test('lower-level normal-stack entry point defaults to PSF and comprehensive weighting', () => {
  const marker = source.indexOf('Future<MilkyWayPipelineResult> registerAndCombineDecodedFrames');
  const body = source.slice(marker, source.indexOf('}) async {', marker));
  assert.match(body, /bool usePsfRefinement = true/);
  assert.match(body, /bool useComprehensiveFrameWeighting = true/);
});
