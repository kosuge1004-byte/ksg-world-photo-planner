import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('classic diagnostics retain hard-gate rejection evidence before minimum-frame refusal', () => {
  const source = fs.readFileSync('lib/core/session/milky_way_pipeline.dart', 'utf8');
  const log = source.indexOf('Milky Way registration diagnostics (classic):');
  const minimum = source.indexOf('if (includedIndices.length < minRegisteredFrames)', log);
  assert.ok(log >= 0 && minimum > log);
  const fields = source.slice(log, minimum);
  for (const name of ['included', 'excludedReason', 'matchedStarCount', 'rmsResidual',
    'registrationRmsLimit', 'residualP95', 'residualMax', 'matchSpanXFraction',
    'matchSpanYFraction', 'matchOccupiedQuadrants', 'localCorrectionApplied', 'registrationWeight']) {
    assert.ok(fields.includes(`diagnostic.${name}`), name);
  }
  const worker = fs.readFileSync('lib/core/background/standard_stack_background_worker.dart', 'utf8');
  assert.ok(Number(worker.match(/'algorithmRevision':\s*(\d+)/)[1]) >= 349);
});
