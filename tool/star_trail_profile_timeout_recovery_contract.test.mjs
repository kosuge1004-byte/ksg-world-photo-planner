import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
const reporter = fs.readFileSync('lib/core/background/stack_job_reporter.dart', 'utf8');
const meteor = fs.readFileSync('lib/core/session/meteor_pipeline.dart', 'utf8');
const processor = fs.readFileSync('android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt', 'utf8');

test('star-trail first pass logs quality-neutral per-stage timing', () => {
  for (const stage of [
    'raw-decode-and-pipeline',
    'green-plane',
    'streak-continuous',
    'streak-fragments',
    'streak-reconnect',
    'streak-total',
    'star-detection',
    'streak-brightness',
    'feature-total',
    'checkpoint-save',
    'journal-save',
    'resource-wait',
    'frame-total',
  ]) {
    assert.match(worker + meteor, new RegExp(`stage=${stage.replace('-', '\\-')}\\b|['\"]${stage}['\"]`));
  }
  assert.match(meteor, /void Function\(String stage, Duration elapsed\)\? reportTiming/);
});

test('durable compact checkpoint count is published into status before Android timeout can preserve it', () => {
  assert.match(reporter, /int\? recoverableCheckpointItems/);
  assert.match(reporter, /_recoverableCheckpointItems\s*=\s*recoverableCheckpointItems\.clamp/);
  assert.match(worker, /stage: '軌跡解析 1\/2',[\s\S]{0,220}recoverableCheckpointItems: rollingRecoverableItems/);
  assert.match(worker, /stage: '比較明合成 2\/2',[\s\S]{0,220}recoverableCheckpointItems: rollingRecoverableItems/);
  assert.match(processor, /JSONObject\(file\.readText\(\)\)/);
  assert.doesNotMatch(processor, /json\.put\("recoverableCheckpointItems",\s*0\)/);
});
