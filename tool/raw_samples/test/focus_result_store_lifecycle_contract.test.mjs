import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const screen = fs.readFileSync(
  new URL('lib/features/focus_stack/focus_stack_screen.dart', root),
  'utf8',
);

test('starting a new focus analysis disposes the previous file-backed result first', () => {
  const start = screen.indexOf('Future<void> _analyzeAndReview() async');
  const end = screen.indexOf('Future<void> _runConfirmedStack', start);
  const body = screen.slice(start, end);
  assert.match(body, /_isSaving/);
  const dispose = body.indexOf('await previousResult.dispose();');
  const clear = body.indexOf('_lastResult = null;');
  assert.ok(dispose >= 0 && clear > dispose);
  assert.match(body, /_lastSavedPath = null;/);
});
