// WORK350 static contract: throughput changes stay result-neutral, workers
// stay cancellable, no ETA is shown, FGS types match the documentation.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const combiner = read('lib/core/stacking/tiled_kappa_sigma_combiner.dart');
const milky = read('lib/core/session/milky_way_pipeline.dart');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const handoff = read('CODEX_HANDOFF_WORK350_TO_EXECUTION.md');
const nativeCmake = read('native/CMakeLists.txt');

function serviceElement(name) {
  const match = manifest.match(new RegExp(`<service\\s+android:name="\\.${name}"[\\s\\S]*?(?:/>|</service>)`));
  assert.ok(match, `${name} must be declared`);
  return match[0];
}

test('kappa-sigma band adapts so the aligned-frame cache is used', () => {
  assert.match(combiner, /int effectiveBandPixels\(\{required int frameCount, required int tileWidth\}\)/);
  assert.match(combiner, /effectiveBandPixels\(frameCount: frameCount, tileWidth: width\) ~\/ width/);
  assert.match(combiner, /if \(cacheablePixels < tileWidth\) return maximumPixelsPerBand;/,
    'must fall back to the exact re-read path, never drop frames');
});

test('Milky Way no longer disables the aligned-frame cache', () => {
  assert.doesNotMatch(milky, /maximumAlignedFrameCacheBytes:\s*0\b/);
  assert.match(milky, /maximumAlignedFrameCacheBytes:\s*32 \* 1024 \* 1024/);
});

test('rejection parameters are unchanged', () => {
  assert.match(milky, /robustSmallStackInitialization: true/);
  assert.match(milky, /synchronizeRgbRejection: true/);
  assert.match(combiner, /this\.kappa = 2\.5/);
  assert.match(combiner, /this\.maximumIterations = 3/);
});

test('parallel star detection reuses the unchanged detector on a read-only reopen', () => {
  assert.match(milky, /FileBackedLinearRgbTileStore\.openCommitted\(/);
  assert.match(milky, /return await _detectRegistrationStars\(\s*store,\s*thresholdSigma: request\.thresholdSigma,\s*usePsfRefinement: request\.usePsfRefinement,/);
  assert.doesNotMatch(milky, /Isolate\.run\(\(\) => _runWorkerStarDetection/,
    'Isolate.run workers cannot be killed on cancellation');
});

test('star detection workers are killable and never outlive the stage', () => {
  assert.match(milky, /Isolate\.spawn\(\s*_starDetectionWorkerEntry,/);
  assert.match(milky, /isolate\.kill\(priority: Isolate\.immediate\)/);
  assert.match(milky, /_isolate\?\.kill\(priority: Isolate\.immediate\);/);
  assert.match(milky, /await _awaitStarWorkerCancellable\(\s*worker,\s*isCancelled: isCancelled,\s*onCancelled: killPrefetchedStarWorkers,/);
  assert.match(milky, /\}\s*finally\s*\{\s*killPrefetchedStarWorkers\(\);\s*\}/);
  assert.match(milky, /if \(isCancelled\?\.call\(\) \?\? false\) throw const TiledStackingCancelled\(\);/);
});

test('no ETA / remaining time is computed or shown (CODEX_HANDOFF_WORK264)', () => {
  assert.doesNotMatch(milky, /残り約|etaMin|remainingMinutes|combineStageText/);
});

test('bit-identity regression test exists', () => {
  assert.ok(existsSync(new URL('test/tiled_kappa_sigma_combiner_cache_equivalence_test.dart', root)));
});

test('ProcessorService stays mediaProcessing', () => {
  const processor = serviceElement('ProcessorService');
  assert.match(processor, /android:foregroundServiceType="mediaProcessing"/);
  assert.doesNotMatch(processor, /specialUse|PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
});

test('SupervisorService specialUse (since Work316) is declared completely and documented', () => {
  const supervisor = serviceElement('SupervisorService');
  assert.match(supervisor, /android:foregroundServiceType="specialUse"/);
  assert.match(supervisor, /android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(handoff, /SupervisorService[^\n]*specialUse/);
  assert.match(handoff, /Play Console/);
  assert.doesNotMatch(handoff, /specialUse[^\n]*コードに含まれない/);
});

test('sanitizer builds link library-consuming C targets with the C++ driver only', () => {
  const block = nativeCmake.match(/if\(MOBILE_STACK_RAW_ENABLE_SANITIZERS\)\s*# WORK350[\s\S]*?endif\(\)/);
  assert.ok(block, 'sanitizer-only linker block must exist');
  assert.match(block[0], /set_target_properties\(\$\{target\} PROPERTIES LINKER_LANGUAGE CXX\)/);
  for (const t of ['mobile_stack_raw_c_contract_test', 'mobile_stack_dng_hardening_test']) {
    assert.ok(block[0].includes(t), `${t} must link as C++ under sanitizers`);
  }
});
