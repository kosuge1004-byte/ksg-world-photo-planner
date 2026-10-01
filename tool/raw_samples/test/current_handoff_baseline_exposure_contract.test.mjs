import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const source = readFileSync(new URL('lib/core/export/linear_dng_writer.dart', root), 'utf8');
const startHere = readFileSync(new URL('CODEX_START_HERE.txt', root), 'utf8');
const pubspec = readFileSync(new URL('pubspec.yaml', root), 'utf8');
const work = `Work${pubspec.match(/^mobilestack_work:\s*(\d+)\s*$/m)[1]}`;
const version = pubspec.match(/^version:\s*(\S+)\s*$/m)[1];
const handoff = readFileSync(
  new URL(`CODEX_HANDOFF_${work.toUpperCase()}_TO_EXECUTION.md`, root),
  'utf8',
);

function currentCheckpointName(text) {
  const match = text.match(/^LATEST BASELINE:\s*(Work\d+)\s*$/m);
  assert.ok(match, 'CODEX_START_HERE must declare a LATEST BASELINE');
  return match[1];
}

test('authoritative handoff keeps final stack DNG BaselineExposure neutral', () => {
  assert.match(
    source,
    /const int _linearDngDefaultRenderBaselineExposureEv = 0\s*\*\s*1;/,
    'production writer must keep Adobe default-render exposure neutral',
  );
  assert.match(
    handoff,
    /最終スタックDNGのBaselineExposureは0 EVを維持。/,
    'authoritative handoff must explicitly preserve BaselineExposure=0 EV',
  );
  assert.match(
    source,
    /Advertising its inverse as BaselineExposure/,
    'writer must forbid reinterpreting storage normalization as Adobe display gain',
  );
});

test('authoritative start file points to the existing current execution handoff', () => {
  assert.equal(currentCheckpointName(startHere), work);
  assert.ok(startHere.includes(`VERSION: ${version}`));
  const releaseGates = readFileSync(new URL('RELEASE_GATES_CURRENT.md', root), 'utf8');
  assert.ok(releaseGates.includes(`Baseline: ${work}`));
  assert.ok(releaseGates.includes(`Version: ${version}`));
  const currentHandoff = readFileSync(
    new URL(`CODEX_HANDOFF_${work.toUpperCase()}_TO_EXECUTION.md`, root),
    'utf8',
  );
  assert.match(currentHandoff, new RegExp(`最新基準は ${work}`));
  assert.match(currentHandoff, /最終スタックDNGのBaselineExposureは0 EVを維持。/);
});
