import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('CFA DNG validity uses existing coverage threshold and exact demosaic radius', () => {
  const validity = readFileSync(
    new URL('../../../lib/core/export/cfa_drizzle_dng_validity.dart', import.meta.url),
    'utf8',
  );
  assert.match(validity, /minimumCoverage/);
  assert.match(validity, /referenceCfaPattern\.colorAt/);
  assert.match(validity, /required int requiredInputRadius/);
  assert.match(validity, /radius:\s*requiredInputRadius/);
  assert.doesNotMatch(validity, /0\.8|80%|newThreshold/);
});

test('CFA export streams direct-RGB validity and precomputes demosaic validity only for Linear DNG', () => {
  const source = readFileSync(
    new URL('../../../lib/core/session/cfa_drizzle_milky_way_export.dart', import.meta.url),
    'utf8',
  );
  assert.match(source, /format == OutputImageFormat\.linearDng/);
  assert.match(source, /CfaDrizzleRgbTransparencyMaskSource/);
  assert.match(source, /saturationCoverageStore:\s*result\.saturationCoverageStore/);
  assert.match(source, /saturationDecisionCoverageStore:/);
  assert.match(source, /CfaDrizzleDemosaicTransparencyMaskSource/);
  assert.match(source, /requiredInputRadius:\s*productionDemosaic\.requiredInputRadius/);
  assert.match(source, /linearDngTransparencyMaskSource:\s*linearDngTransparencyMaskSource/);
});
