import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const worker = read('lib/core/background/standard_stack_background_worker.dart');
const memory = read('lib/core/engine/memory_admission_controller.dart');
const reporter = read('lib/core/background/stack_job_reporter.dart');
const pipeline = read('lib/core/session/export_pipeline_result.dart');
const supervisor = read('android/app/src/main/kotlin/com/mobilestack/app/SupervisorService.kt');
const processor = read('android/app/src/main/kotlin/com/mobilestack/app/ProcessorService.kt');
const checkpoint = read('lib/core/background/post_decode_pipeline_checkpoint_store.dart');

const checks = [
  ['memory admission controller exists', memory.includes('final class MemoryAdmissionController')],
  ['predicts next RAW memory', memory.includes('estimateFullFrameAdditionalBytes')],
  ['predicts post-decode memory', memory.includes('estimatePostDecodeAdditionalBytes')],
  ['quality-neutral contract', memory.includes('No image dimensions, demosaic settings')],
  ['RSS trend tracked', memory.includes('_monotonicGrowthSamples')],
  ['processor budget enforced', memory.includes('processBudgetEnough')],
  ['available RAM headroom enforced', memory.includes('availableEnough')],
  ['checkpoint-aware recycle', memory.includes('checkpointAvailable') && memory.includes('shouldRecycleProcessor')],
  ['RAW admission integrated', worker.includes('memory-admission-raw')],
  ['post-decode admission integrated', worker.includes('memory-admission-postdecode')],
  ['export admission integrated', worker.includes('memory-admission-export')],
  ['source stores released before export', worker.includes('releaseDecodedSourceStores')],
  ['pipeline lifecycle callback star trail', pipeline.includes('All source-frame reads (including optional gap analysis) are finished.')],
  ['pipeline lifecycle callback milky way', pipeline.includes('Registration/stacking no longer needs decoded source frames.')],
  ['maintenance restart signal type', reporter.includes('ProcessorMaintenanceRestartRequested')],
  ['maintenance restart durable marker', reporter.includes('supervisor-maintenance-restart')],
  ['maintenance restart does not use failure marker', reporter.includes('not a processing failure and must not consume the') && reporter.includes('bounded automatic-failure retry budget')],
  ['supervisor consumes maintenance marker', supervisor.includes('maintenanceRestartMarker(config.statusPath).delete()')],
  ['supervisor maintenance bypasses bounded failure recovery', supervisor.includes('maintenance heap recycle')],
  ['processor waits for maintenance supervisor', processor.includes('supervisor-maintenance-restart')],
  ['two-generation checkpoint current', checkpoint.includes('current.json')],
  ['two-generation checkpoint previous', checkpoint.includes('previous.json')],
  ['export receipt retained', checkpoint.includes('export_receipt.json')],
  ['source callback connected for both modes', (worker.match(/onSourceStoresNoLongerNeeded: releaseDecodedSourceStores/g) || []).length === 2],
  ['duplicate contribution argument absent', (pipeline.match(/contributionStore: contributionStore,/g) || []).length === 1],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
