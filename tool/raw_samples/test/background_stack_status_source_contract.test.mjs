import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const controller = readFileSync(
  new URL('../../../lib/core/background/background_stack_controller.dart', import.meta.url),
  'utf8',
);
const reporter = readFileSync(
  new URL('../../../lib/core/background/stack_job_reporter.dart', import.meta.url),
  'utf8',
);
const screen = readFileSync(
  new URL('../../../lib/features/milkyway/cfa_drizzle_milky_way_progress_screen.dart', import.meta.url),
  'utf8',
);
const worker = readFileSync(
  new URL('../../../lib/core/background/cfa_drizzle_background_worker.dart', import.meta.url),
  'utf8',
);
const pipeline = readFileSync(
  new URL('../../../lib/core/session/cfa_drizzle_milky_way_pipeline.dart', import.meta.url),
  'utf8',
);

test('highest-quality CFA stack is scheduled as a long-running foreground worker', () => {
  assert.match(controller, /registerOneOffTask/);
  assert.match(controller, /foregroundServiceConfig:\s*ForegroundServiceConfig\(/);
  assert.match(controller, /enableRobustRejection/);
  assert.match(controller, /useComprehensiveFrameWeighting/);
  assert.match(controller, /usePsfRefinement/);
});

test('worker preserves highest-quality output and Linear DNG path', () => {
  assert.match(worker, /enableRobustRejection:\s*enableRobustRejection/);
  assert.match(worker, /useComprehensiveFrameWeighting:\s*useComprehensiveFrameWeighting/);
  assert.match(worker, /usePsfRefinement:\s*usePsfRefinement/);
  assert.match(worker, /format:\s*OutputImageFormat\.linearDng/);
  assert.match(worker, /localToneStrength:\s*0/);
});

test('proof-of-life heartbeat is persistent and periodic', () => {
  assert.match(reporter, /Duration\(seconds:\s*10\)/);
  assert.match(reporter, /heartbeat/);
  assert.match(reporter, /writeAtomically\(\s*statusPath/);
  assert.match(reporter, /Workmanager\(\)\.reportProgress/);
});

test('UI shows real status fields and deliberately has no ETA', () => {
  for (const label of ['進捗率', '経過時間', '現在工程', '処理枚数', '最終更新', 'Heartbeat']) {
    // 進捗率 is represented by the percentage itself; the others are literal labels.
    if (label !== '進捗率') assert.match(screen, new RegExp(label));
  }
  assert.doesNotMatch(screen, /_StatusRow\(\s*label:\s*['"]残り時間['"]/);
  assert.doesNotMatch(screen, /_StatusRow\(\s*label:\s*['"]ETA['"]/i);
  assert.match(screen, /別のアプリを開いた場合や画面をOFFにした場合も/);
});

test('pipeline reports concrete processing stages and item counts', () => {
  for (const stage of [
    'RAW解析・較正',
    '星検出・参照フレーム選択',
    '高精度位置合わせ',
    'CFA Drizzle',
    'ロバスト外れ値除去',
  ]) {
    assert.match(pipeline, new RegExp(stage));
  }
  assert.match(pipeline, /required int current/);
  assert.match(pipeline, /required int total/);
});
