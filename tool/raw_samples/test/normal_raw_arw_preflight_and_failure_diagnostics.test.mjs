import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const selection = fs.readFileSync(
  new URL('lib/features/common/raw_selection_screen.dart', root),
  'utf8',
);
const progress = fs.readFileSync(
  new URL('lib/features/common/processing_progress_screen.dart', root),
  'utf8',
);

test('normal RAW selection probes ARW with the production native metadata probe', () => {
  assert.match(selection, /metadataProbe:\s*createProductionNativeRawMetadataProbe\(\)/);
  assert.doesNotMatch(selection, /metadataProbe:\s*createFeatureFlaggedNativeRawMetadataProbe\(\)/);
});

test('processing recheck uses the same production native metadata probe', () => {
  assert.match(progress, /_metadataProbe = createProductionNativeRawMetadataProbe\(\)/);
});

test('failed scheduler jobs expose concrete file stage and exception details', () => {
  assert.match(progress, /List<ProcessingJob> get _failedJobs/);
  assert.match(progress, /job\.currentStageLabel \?\? 'RAWファイル検証／ネイティブデコード'/);
  assert.match(progress, /job\.error/);
  assert.match(progress, /class _FailureDetailsCard/);
  assert.match(progress, /SelectableText\(\s*messageFor\(failedJobs\[i\]\)/s);
});

test('failed 0-percent jobs no longer masquerade as the input-file stage', () => {
  assert.match(progress, /class _FailedStageSummary/);
  assert.match(progress, /widget\.session\.status == SessionStatus\.failed/);
  assert.match(progress, /stage:\s*_failureStage\(_failedJobs\.first\)/);
});
