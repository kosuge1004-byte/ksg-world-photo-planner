import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const worker = read('lib/core/background/standard_stack_background_worker.dart');
const pipeline = read('lib/core/session/star_trail_pipeline.dart');

test('fused path is disabled for features that need in-order or all-frames data', () => {
  assert.match(worker, /bool fusedStarTrail = starTrailFusedPremergeEnabled &&\n\s+!starTrailHotPixelRemoval &&\n\s+!starTrailMeanBackground &&\n\s+!\(starTrailForegroundAverage &&\n\s+automaticStarTrailForegroundProtection\) &&\n\s+!await fusedDisabledMarker\.exists\(\);/);
});

test('only frames that cannot receive exclusions are premerged, with no exclusions', () => {
  assert.match(worker, /automaticStarTrailAircraftRemoval && features\.streaks\.isNotEmpty;/);
  assert.match(worker, /checkpointStage: 'premerge',/);
  const premerge = worker.slice(worker.indexOf('final premerged = await mergeStarTrailFrameIntoRollingAccumulator('), worker.indexOf("checkpointStage: 'premerge',"));
  assert.doesNotMatch(premerge, /excludedStreaks:/);
  assert.match(premerge, /frameWeight: starTrailFadeWeights\[index\],/);
});

test('second pass skips premerged frames and falls back in order on a signed-zero tie', () => {
  assert.match(worker, /if \(fusedStarTrail && !mayReceiveExclusions\(features\[index\]\)\) \{\n\s+\/\/ Already merged during the analysis pass \(premerge\)\.\n\s+continue;/);
  assert.match(worker, /onSignedZeroTie: fusedStarTrail\n\s+\? \(\) \{\n\s+restartInOrder = true;/);
  assert.match(worker, /await fusedDisabledMarker\.writeAsString\('1', flush: true\);/);
  assert.match(worker, /\} while \(restartInOrder\);/);
  assert.match(worker, /checkpointStage: fusedStarTrail \? 'fusedRolling' : 'rolling',/);
});

test('an in-order second pass already under way is never mixed with the fused path', () => {
  assert.match(worker, /if \(restoredStage == 'rolling'\) \{[\s\S]{0,200}fusedStarTrail = false;/);
});

test('the merge only checks ties when asked (legacy loop unchanged)', () => {
  assert.match(pipeline, /if \(onSignedZeroTie != null &&\n\s+weighted == 0 &&\n\s+old\[offset\] == 0 &&\n\s+weighted\.isNegative != old\[offset\]\.isNegative\) \{/);
  assert.match(pipeline, /out\[offset\] = weighted > old!\[offset\] \? weighted : old\[offset\];/);
});
