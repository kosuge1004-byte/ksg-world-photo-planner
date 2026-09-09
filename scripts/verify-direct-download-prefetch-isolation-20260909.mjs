import fs from 'node:fs';

const dem = fs.readFileSync('src/cesium/gsiDemTileCache.ts', 'utf8');
const mgr = fs.readFileSync('src/cache/tripodBearingProfileManager.ts', 'utf8');

const checks = [
  ['prefetch uses one global queue', dem.includes('const queuedPrefetch = new Map') && dem.includes('function pumpPrefetchQueue()')],
  ['per-call prefetch worker pool removed', !dem.includes('Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, () => worker())')],
  ['bulk terrain pass pauses background tile fetches', mgr.includes('pauseGsiDeviceTilePrefetch();')],
  ['bulk terrain pass resumes before final tile drain', mgr.includes('resumeDeviceTilePrefetch();') && mgr.includes('flushGsiDeviceTilePrefetchQueue()')],
  ['tile drain occurs after terrain workers finish', mgr.indexOf('await Promise.all(Array.from({ length: workerCount }, () => worker()));') < mgr.indexOf('await flushGsiDeviceTilePrefetchQueue()')],
  ['foreground precision unchanged at 1m', mgr.includes('sampleWorldTerrainNeutral(terrainPoints, stageSignal, "1m")')],
  ['background tile prefetch is deduplicated before queueing', dem.includes('inFlightPrefetch.has(key) || queuedPrefetch.has(key)')],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log(`PASS: ${checks.length}/${checks.length} checks`);
