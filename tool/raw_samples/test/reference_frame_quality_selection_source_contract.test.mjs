import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const normal = readFileSync(
  new URL('../../../lib/core/session/milky_way_pipeline.dart', import.meta.url),
  'utf8',
);
const cfa = readFileSync(
  new URL('../../../lib/core/session/cfa_drizzle_milky_way_pipeline.dart', import.meta.url),
  'utf8',
);

test('normal stack scores all detected candidates before selecting reference', () => {
  assert.match(normal, /final Map<int, List<DetectedStar>> detectedStarsByFrame/);
  assert.match(normal, /intrinsicReferenceFrameQualityWeight/);
  assert.match(normal, /bestObservedStarCount/);
  assert.doesNotMatch(
    normal,
    /for \(int index = 0; index < frameStores\.length; index\+\+\) \{\s*if \(frameStores\[index\] == null\) continue;\s*referenceIndex = index;\s*break;/,
  );
});

test('CFA Drizzle scores all detected candidates before selecting reference', () => {
  assert.match(cfa, /final Map<int, List<DetectedStar>> detectedStarsByFrame/);
  assert.match(cfa, /intrinsicReferenceFrameQualityWeight/);
  assert.match(cfa, /bestObservedStarCount/);
  assert.doesNotMatch(
    cfa,
    /for \(int index = 0; index < effectiveMosaics\.length; index\+\+\) \{\s*if \(effectiveMosaics\[index\] == null\) continue;\s*referenceIndex = index;\s*break;/,
  );
});

test('both pipelines reuse cached star detections after reference selection', () => {
  assert.match(normal, /final List<DetectedStar>\? targetStars = detectedStarsByFrame\[index\]/);
  assert.match(cfa, /final List<DetectedStar>\? targetStars = detectedStarsByFrame\[index\]/);
});

test('CFA Drizzle gives the reference frame the same comprehensive quality policy as normal stacking', () => {
  assert.match(cfa, /final double referenceRegistrationWeight = registrationQualityWeight\(/);
  assert.match(cfa, /final double referenceWeight = useComprehensiveFrameWeighting[\s\S]*comprehensiveFrameQualityWeight\(/);
  assert.match(cfa, /registrationWeight: referenceWeight/);
  assert.match(cfa, /weightsByIncludedIndex = <double>\[referenceWeight\]/);
  assert.doesNotMatch(cfa, /weightsByIncludedIndex = <double>\[1\]/);
});



test('both pipelines keep best-observed star count as the stacking quality baseline', () => {
  for (const [label, source, expectedUses] of [
    ['normal', normal, 4], // batch path plus the compact rolling planner
    ['CFA', cfa, 2],
  ]) {
    const bestObservedUses = source.match(/referenceStarCount:\s*bestObservedStarCount/g) ?? [];
    assert.equal(
      bestObservedUses.length,
      expectedUses,
      `${label} pipeline must use bestObservedStarCount for reference and target frame weights in every planner`,
    );
    assert.doesNotMatch(
      source,
      /referenceStarCount:\s*referenceStars\.length/,
      `${label} pipeline must not reset the star-count quality baseline to the selected reference`,
    );
  }
});
