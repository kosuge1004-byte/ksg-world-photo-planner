import fs from 'node:fs';
import assert from 'node:assert/strict';

const device = fs.readFileSync(new URL('../src/cache/deviceCache.ts', import.meta.url), 'utf8');
const tripod = fs.readFileSync(new URL('../src/cesium/tripodCandidates.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const weather = fs.readFileSync(new URL('../src/search/refractionWeather.ts', import.meta.url), 'utf8');

const checks = [
  ['IDB open timeout exists', /INDEXED_DB_OPEN_TIMEOUT_MS\s*=\s*1_500/.test(device)],
  ['IDB operation timeout exists', /INDEXED_DB_OPERATION_TIMEOUT_MS\s*=\s*1_500/.test(device)],
  ['blocked open fails open', /request\.onblocked\s*=\s*\(\)\s*=>\s*finish\(null\)/.test(device)],
  ['failed open promise is reset', /databasePromise === opening\) databasePromise = null/.test(device)],
  ['cache reads are bounded', /const record = await boundedCacheOperation\(/.test(device)],
  ['batch cache reads are bounded', /await boundedCacheOperation\(\s*Promise\.all\(missing/.test(device)],
  ['cache writes are bounded', /await boundedCacheOperation\([\s\S]*?transaction\.objectStore\(STORE_NAME\)\.put\(record\)/.test(device)],
  ['existing valid weather is reused', /activeRefractionWeather\.effectiveMode !== "weather"/.test(tripod)],
  ['weather resolver remains fallback', /const resolvedWeather = await refractionWeatherResolver\(subject, signal\)/.test(tripod)],
  ['timeline drag still avoids DEM solve', /if \(timelineInteracting\)[\s\S]*?displayedTripodCandidates/.test(app)],
  ['previous candidate ref still drives drag projection', /tripodCandidatesRef\.current[\s\S]*?previousById/.test(app)],
  ['weather cache write does not block forecast result', /void writeCache\(key, \"forecast\"/.test(weather)],
  ['weather cache write does not block historical result', /void writeCache\(key, \"historical\"/.test(weather)],
  ['weather cache write does not block climatology result', /void writeCache\(key, \"climatology\"/.test(weather)],
  ['authoritative candidate calculation remains present', /calculateTripodCandidates\(/.test(app)],
];

for (const [name, ok] of checks) {
  assert.ok(ok, name);
  console.log(`PASS: ${name}`);
}
console.log(`PASS ${checks.length}/${checks.length}`);
