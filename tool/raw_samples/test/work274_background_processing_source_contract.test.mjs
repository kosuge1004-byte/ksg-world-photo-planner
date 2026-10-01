import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => fs.readFileSync(p, 'utf8');
const raw = read('lib/features/common/raw_selection_screen.dart');
const cal = read('lib/features/common/calibration_frame_options_screen.dart');
const dispatch = read('lib/core/background/background_task_dispatcher.dart');
const standard = read('lib/core/background/standard_stack_background_worker.dart');
const focus = read('lib/core/background/focus_stack_background_worker.dart');
const focusMarking = read('lib/core/background/focus_marking_background_worker.dart');
const focusUi = read('lib/features/focus_stack/focus_stack_screen.dart');
const meteor = read('lib/core/background/meteor_background_worker.dart');
const meteorComposite = read('lib/core/background/meteor_composite_background_worker.dart');
const meteorReview = read('lib/features/meteor/meteor_review_screen.dart');
const progress = read('lib/features/common/standard_background_progress_screen.dart');
const notifications = read('lib/core/background/stack_job_notifications.dart');
assert.match(raw, /ProcessingMode\.meteor[\s\S]*StandardBackgroundProgressScreen/);
assert.match(cal, /ProcessingMode\.meteor[\s\S]*StandardBackgroundProgressScreen[\s\S]*darkFramePaths/);
assert.doesNotMatch(raw, /requireReferenceSelection[\s\S]{0,160}ProcessingMode\.meteor/);
for (const fn of [
  'runStandardStackBackgroundTask',
  'runFocusStackBackgroundTask',
  'runFocusMarkingBackgroundTask',
  'runMeteorBackgroundTask',
  'runMeteorCompositeBackgroundTask',
]) assert.match(dispatch, new RegExp(fn));
assert.match(standard, /automaticStarTrailAircraftRemoval/);
assert.match(standard, /automaticMovingObjectRemoval/);
assert.match(standard, /quality\.maximumIterations/);
assert.match(standard, /quality\.interpolation/);
assert.match(standard, /reportProgress:[\s\S]*0\.58 \+ progress \* 0\.41/);
assert.match(focus, /runFocusStackPipeline/);
assert.match(focus, /exportFocusStackResult/);
assert.match(focusMarking, /analyzeFocusMarking/);
assert.match(focusMarking, /合焦位置の解析が完了しました/);
assert.match(focusUi, /BackgroundStackController\.startFocusMarking/);
assert.match(focusUi, /BackgroundStackController\.startFocusStack/);
assert.match(meteor, /runMeteorAnalysisPipeline/);
assert.match(meteor, /流星候補の解析が完了しました/);
assert.match(meteorComposite, /compositeSelectedMeteorStreaksTiledAndExport/);
assert.match(meteorComposite, /流星群の最終画像が完成しました/);
assert.match(dispatch, /runMeteorCompositeBackgroundTask/);
assert.match(meteorReview, /onBackgroundCompositeRequested/);
assert.match(progress, /readMeteorAnalysisResult/);
assert.match(progress, /readFocusMarkingBackgroundResult/);
assert.match(progress, /startFocusStack/);
assert.match(progress, /startMeteorComposite/);
assert.match(meteorReview, /_releaseFrameStoresForBackground/);
assert.match(notifications, /title: '\$jobLabel 完了'/);
console.log('WORK274 background source contracts: PASS');
