import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/native-raw-abi.yml', root), 'utf8');
const preflight = readFileSync(new URL('tool/work187_codex_preflight.sh', root), 'utf8');
const runner = readFileSync(new URL('tool/run_all_node_tests.sh', root), 'utf8');

test('CI and local preflight share the complete Node regression runner', () => {
  assert.match(
    workflow,
    /run:\s+bash tool\/run_all_node_tests\.sh/,
    'GitHub Actions must execute the shared complete Node regression runner',
  );
  assert.match(
    preflight,
    /bash tool\/run_all_node_tests\.sh/,
    'local preflight must execute the same complete Node regression runner',
  );
});

test('shared Node runner dynamically discovers every tool test', () => {
  assert.match(runner, /find tool -type f -name '\*\.test\.mjs' -print0/);
  assert.match(runner, /sort -z/);
  assert.match(runner, /node --test "\$\{node_tests\[@\]\}"/);
  assert.doesNotMatch(
    runner,
    /tool\/raw_samples\/test\/[A-Za-z0-9_.-]+\.test\.mjs\s+tool\//,
    'runner must not regress to a hand-maintained partial test list',
  );
});
