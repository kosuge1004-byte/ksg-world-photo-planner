import fs from 'node:fs';
const read = p => fs.readFileSync(p, 'utf8');
const ex = read('lib/core/engine/phase2_validated_job_executor.dart');
const st = read('lib/core/engine/streamed_raw_phase2_executor.dart');
const bg = read('lib/core/background/standard_stack_background_worker.dart');
const required = [
  [ex, 'preferStreamedRawCalibration = false'],
  [ex, 'runStreamedRawPhase2('],
  [ex, 'tileStoreTransferred = true'],
  [ex, "onRawExecutionPathReady?.call('streamed-file-backed')"],
  [bg, 'rawPath frame=$index path=$path'],
  [st, 'LinearizationTable -> black subtraction'],
  [st, 'value = value - metadata.blackLevels[phase] - spatialOffset'],
  [st, 'value *= whiteScale'],
  [st, 'value *= wb[phase]'],
  [st, 'value /= flatValue'],
  [st, 'processFileBackedTile('],
  [bg, 'preferStreamedRawCalibration: true'],
];
for (const [text, needle] of required) {
  if (!text.includes(needle)) throw new Error(`missing Work301 invariant: ${needle}`);
}
console.log('Work301 streamed RAW calibration static invariants: PASS');
