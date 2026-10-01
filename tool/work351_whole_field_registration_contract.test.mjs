import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Work351 static contract: guided whole-field registration is opt-in and
// the legacy (default) path is structurally unchanged.

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const affine = read('lib/core/registration/affine_sampling_transform.dart');
const pipeline = read('lib/core/session/milky_way_pipeline.dart');
const worker = read('lib/core/background/standard_stack_background_worker.dart');
const controller = read('lib/core/background/background_stack_controller.dart');
const settings = read('lib/core/settings/app_settings.dart');
const residual = read('lib/core/registration/local_residual_correction.dart');
const manifest = read('android/app/src/main/AndroidManifest.xml');

test('affine evaluation keeps the exact pre-Work351 expression when not projective', () => {
  assert.match(affine, /if \(!isProjective\) return m00 \* outputX \+ m01 \* outputY \+ m02;/);
  assert.match(affine, /if \(!isProjective\) return m10 \* outputX \+ m11 \* outputY \+ m12;/);
  assert.match(affine, /this\.p20 = 0,\n\s+this\.p21 = 0,/);
  assert.match(affine, /\? <double>\[m00, m01, m02, m10, m11, m12, p20, p21\]\n\s+: <double>\[m00, m01, m02, m10, m11, m12\];/);
});

test('local residuals are evaluated through the transform (projective-safe)', () => {
  assert.match(residual, /globalTransform\.sourceX\(reference\.x, reference\.y\)/);
  assert.doesNotMatch(residual, /globalTransform\.m00 \* reference\.x/);
});

test('legacy rigid is the default everywhere', () => {
  assert.match(pipeline, /enum MilkyWayRegistrationModel \{ legacyRigid, guidedWholeField \}/);
  assert.match(pipeline, /orElse: \(\) => MilkyWayRegistrationModel\.legacyRigid/);
  const defaults = pipeline.match(/MilkyWayRegistrationModel registrationModel =\n\s+MilkyWayRegistrationModel\.legacyRigid,/g) ?? [];
  assert.ok(defaults.length >= 4, `default parameters: ${defaults.length}`);
  assert.match(settings, /static const bool defaultWholeFieldRegistration = false;/);
});

test('legacy registration still calls the rigid estimator with the historical arguments', () => {
  const legacy = pipeline.match(/estimate = estimateSimilarityTransform\(\n\s+referenceStars,\n\s+targetStars,\n\s+toleranceRadius: transformToleranceRadius,\n\s+minInliers: 5,\n\s+\);/g) ?? [];
  assert.equal(legacy.length, 2, 'plan and classic paths');
  assert.match(pipeline, /maxStars: guided \? _guidedPreviewStarCandidates : 200,/);
});

test('coverage gate and temporal-center preference are guided-only', () => {
  assert.match(pipeline, /guidedResults != null\n\s+\? evaluateRegistrationCoverageGate\(/);
  const pref = pipeline.match(/if \(guided && referenceIndex == null\) \{\n\s+_preferTemporalCenterInPlace\(/g) ?? [];
  assert.equal(pref.length, 2);
});

test('final PSF gate detects with the same model as the reference list', () => {
  assert.match(pipeline, /usePsfRefinement: true,\n\s+isCancelled: isCancelled,\n\s+registrationModel: registrationModel,/);
  assert.match(worker, /finalized\.rgb,\n\s+isCancelled: \(\) => reporter\.cancellationRequested,\n\s+registrationModel: milkyWayRegistrationModel,/);
});

test('payload carries the model; payloads without it resume as legacy', () => {
  assert.match(controller, /'milkyWayRegistrationModel': session\.wholeFieldRegistration\n\s+\? 'guidedWholeField'\n\s+: 'legacyRigid',/);
  assert.match(worker, /milkyWayRegistrationModelFromName\(\n\s+input\['milkyWayRegistrationModel'\] as String\?,/);
  const uses = worker.match(/registrationModel: milkyWayRegistrationModel,/g) ?? [];
  assert.equal(uses.length, 4, 'compact detection, plan, final PSF, classic');
});

test('Work351 does not change the processor FGS type', () => {
  assert.match(manifest, /android:name="\.ProcessorService"[\s\S]{0,400}android:foregroundServiceType="mediaProcessing"/);
});
