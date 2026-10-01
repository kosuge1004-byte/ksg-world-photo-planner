import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  'lib/core/background/standard_stack_background_worker.dart',
  'utf8',
);

assert.match(source, /class _StarTrailDecodeCheckpointStore/);
assert.match(source, /star_trail_decode_checkpoints_v1/);
assert.match(source, /FileBackedLinearRgbTileStore\.openCommitted/);
assert.match(source, /publishCommittedFrame/);
assert.match(source, /writeAsString\(jsonEncode\(payload\), flush: true\)/);
assert.match(source, /sourceByteLength/);
assert.match(source, /sourceModifiedMs/);
assert.match(source, /if \(index == referenceIndex\) continue;/);
assert.match(source, /if \(frameStores\[index\] != null\)/);
assert.match(source, /reportProgress\(1\.0\)/);
assert.match(source, /decodeCheckpoints\.createStore/);
assert.match(source, /closeRetainingCheckpoint/);
assert.match(source, /await decodeCheckpoints\?\.cleanupAll\(\)/);
assert.match(
  source,
  /Missing or mismatched final-render profile for star-trail/,
);

console.log('star-trail process-death checkpoint source contract: PASS');
