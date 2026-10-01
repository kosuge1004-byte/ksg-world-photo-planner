import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');

test('star-trail foreground protection is wired through UI and background paths', () => {
  const session = read('lib/core/session/processing_session.dart');
  const settings = read('lib/features/common/stack_settings_screen.dart');
  const controller = read('lib/core/background/background_stack_controller.dart');
  const worker = read('lib/core/background/standard_stack_background_worker.dart');
  const progress = read('lib/features/common/processing_progress_screen.dart');
  const pipeline = read('lib/core/session/star_trail_pipeline.dart');

  assert.match(session, /automaticStarTrailForegroundProtection/);
  assert.match(settings, /地上の一時的な光を抑える/);
  assert.match(controller, /'automaticStarTrailForegroundProtection'/);
  assert.match(worker, /preserveReferenceForeground:\s*automaticStarTrailForegroundProtection/);
  assert.match(progress, /preserveReferenceForeground:\s*\n\s*widget\.session\.automaticStarTrailForegroundProtection/);
  assert.match(pipeline, /preserveReferenceAgainstBroadTransientBrightening/);
  assert.match(pipeline, /foregroundRegion: foregroundRegion!/);
  assert.match(pipeline, /foregroundWeights: foregroundRegion.weights/);
  assert.match(pipeline, /region.outputX - 8/);
  assert.match(pipeline, /referenceStore.readRegion/);
});
