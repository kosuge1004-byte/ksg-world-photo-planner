import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const log = read('lib/core/diagnostics/diagnostic_log.dart');
const settings = read('lib/features/settings/settings_screen.dart');
const panel = read('lib/features/common/processing_failure_panel.dart');

test('a new run keeps the previous run log instead of erasing it', () => {
  assert.match(log, /await file\.rename\(previous\.path\);/);
  assert.match(log, /return File\('\$\{stem\}_previous\.txt'\);/);
});

test('logs are exported as timestamped text files', () => {
  assert.match(log, /static Future<List<File>> exportForSharing\(\) async \{/);
  assert.match(log, /'mobile_stack_log_\$stamp\.txt'/);
  assert.match(log, /'mobile_stack_log_\$\{stamp\}_previous_run\.txt'/);
});

test('settings and the failure panel share the files with text/plain', () => {
  assert.match(settings, /title: const Text\('診断ログをファイルで共有'\)/);
  assert.match(settings, /XFile\(file\.path, mimeType: 'text\/plain'\)/);
  assert.match(panel, /key: const Key\('share-diagnostic-log'\)/);
  assert.match(panel, /XFile\(file\.path, mimeType: 'text\/plain'\)/);
  assert.match(settings, /title: const Text\('診断ログをコピー'\)/);
});
