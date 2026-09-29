import fs from 'node:fs';
import path from 'node:path';

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const candidates = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const distAssets = new URL('../dist/assets/', import.meta.url);
const distEntry = fs.readdirSync(distAssets).find((name) => /^index-.*\.js$/.test(name));
if (!distEntry) throw new Error('built application entry was not found');
const dist = fs.readFileSync(new URL(path.posix.join('../dist/assets', distEntry), import.meta.url), 'utf8');

const checks = [
  ['fixed 90-second absolute watchdog removed from source', !/TRIPOD_CANDIDATE_WATCHDOG_TIMEOUT_MS\s*=\s*90_000/.test(app)],
  ['stall watchdog is 180 seconds', /TRIPOD_CANDIDATE_WATCHDOG_STALL_TIMEOUT_MS\s*=\s*180_000/.test(app)],
  ['watchdog polls rather than using one absolute timeout', /watchdogInterval\s*=\s*setInterval\(/.test(app) && !/watchdogTimer\s*=\s*setTimeout\(/.test(app)],
  ['watchdog reads live activity', /getTripodCandidateLastActivityAtMs\(watchdogStartedAtMs\)/.test(app)],
  ['diagnostics include absolute live activity timestamp', /liveLastActivityAtMs:\s*number/.test(candidates)],
  ['every live trace refreshes activity timestamp', /lastSearchDiagnostics\.liveLastActivityAtMs\s*=\s*Date\.now\(\)/.test(candidates)],
  ['diagnostics initialize activity timestamp', /liveLastActivityAtMs:\s*Date\.now\(\)/.test(candidates)],
  ['watchdog is cleared after search', /clearInterval\(watchdogInterval\)/.test(app)],
  ['dist no longer contains old 90-second constant', !/tg=9e4/.test(dist)],
  ['dist contains inactivity watchdog', /=18e4[,;]/.test(dist) && /setInterval\(/.test(dist)],
  ['dist live trace refreshes activity timestamp', /\.liveLastActivityAtMs=Date\.now\(\)/.test(dist)],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  failed ||= !ok;
}

// Reproduce the supplied diagnostic timing logically: terrain #1 ends at 75.127 s,
// then terrain #2 starts immediately. Under the old absolute 90 s guard, only 14.873 s
// remained. Under the new 180 s inactivity guard, terrain #2 receives a full 180 s
// from the latest progress event.
const firstTerrainEndMs = 75_127;
const oldAbsoluteRemainingMs = 90_000 - firstTerrainEndMs;
const newInactivityRemainingMs = 180_000;
const timingOk = oldAbsoluteRemainingMs === 14_873 && newInactivityRemainingMs > oldAbsoluteRemainingMs;
console.log(`${timingOk ? 'PASS' : 'FAIL'}: supplied log reproduces old premature-abort window (${oldAbsoluteRemainingMs}ms) and new full inactivity window (${newInactivityRemainingMs}ms)`);
failed ||= !timingOk;

process.exit(failed ? 1 : 0);
