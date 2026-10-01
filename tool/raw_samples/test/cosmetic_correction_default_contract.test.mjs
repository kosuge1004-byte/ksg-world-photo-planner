
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('production RAW calibration defaults keep automatic hot/cold cosmetic correction opt-in', () => {
  const factory = readFileSync(
    new URL('../../../lib/core/pipeline/phase2_quality_pipeline_factory.dart', import.meta.url),
    'utf8',
  );
  const executor = readFileSync(
    new URL('../../../lib/core/engine/phase2_validated_job_executor.dart', import.meta.url),
    'utf8',
  );

  const hotFalseCount = (factory.match(/bool enableHotPixelDetection = false,/g) ?? []).length;
  const coldFalseCount = (factory.match(/bool enableColdPixelDetection = false,/g) ?? []).length;
  assert.ok(hotFalseCount >= 2);
  assert.ok(coldFalseCount >= 2);
  assert.match(executor, /bool enableHotPixelDetection = false,/);

  assert.doesNotMatch(factory, /bool enableHotPixelDetection = true,/);
  assert.doesNotMatch(factory, /bool enableColdPixelDetection = true,/);
});
