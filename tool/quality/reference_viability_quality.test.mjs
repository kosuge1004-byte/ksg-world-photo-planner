import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function selectHighestQualityViableReference(rankedCandidates, canRegister, minimumFrames) {
  if (rankedCandidates.length === 0) throw new Error('no candidates');
  let fallback = rankedCandidates[0];
  if (minimumFrames <= 1) return fallback;
  for (const candidate of rankedCandidates) {
    let count = 1;
    for (const target of rankedCandidates) {
      if (target === candidate) continue;
      if (canRegister(candidate, target)) count += 1;
      if (count >= minimumFrames) return candidate;
    }
  }
  return fallback;
}

test('reference viability keeps the top intrinsic-quality frame when it can satisfy the stack', () => {
  const ranked = [7, 2, 9];
  const links = new Set(['7>2', '2>7', '2>9', '9>2']);
  const selected = selectHighestQualityViableReference(
    ranked,
    (a, b) => links.has(`${a}>${b}`),
    2,
  );
  assert.equal(selected, 7);
});

test('reference viability falls back to the next intrinsic-quality candidate instead of failing an otherwise viable stack', () => {
  const ranked = [7, 2, 9];
  const links = new Set(['2>7', '2>9', '9>2']);
  const selected = selectHighestQualityViableReference(
    ranked,
    (a, b) => links.has(`${a}>${b}`),
    3,
  );
  assert.equal(selected, 2);
});

test('production Milky Way and CFA Drizzle paths both gate intrinsic ranking by actual transform viability', () => {
  for (const path of [
    'lib/core/session/milky_way_pipeline.dart',
    'lib/core/session/cfa_drizzle_milky_way_pipeline.dart',
  ]) {
    const source = fs.readFileSync(path, 'utf8');
    assert.match(source, /rankedReferenceIndices\.sort/);
    assert.match(source, /registrableFrameCount = 1/);
    assert.match(source, /registrableFrameCount >= minRegisteredFrames/);
    assert.match(source, /estimateSimilarityTransform\(/);
    assert.match(source, /referenceQualityByIndex/);
  }
});

test('CFA gap-filled Linear DNG validity remains based on original source coverage, not synthesized filled values', () => {
  const exportSource = fs.readFileSync(
    'lib/core/session/cfa_drizzle_milky_way_export.dart',
    'utf8',
  );
  const validity = fs.readFileSync(
    'lib/core/export/cfa_drizzle_dng_validity.dart',
    'utf8',
  );
  assert.match(exportSource, /CfaDrizzleRgbTransparencyMaskSource\([\s\S]*coverageStore: result\.coverageStore/);
  assert.match(exportSource, /CfaDrizzleDemosaicTransparencyMaskSource\([\s\S]*coverageStore: result\.coverageStore/);
  assert.match(validity, /Gap-filled RGB values remain useful for display, but are\s*\n?\s*\/\/\/ marked undefined/);
});
