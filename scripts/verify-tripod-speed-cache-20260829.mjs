import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  exactTripodCacheKey,
  getExactTripodCandidates,
  setExactTripodCandidates,
} from '../src/cesium/tripodCandidateExactCache.ts';

const base = {
  subject: { latitude: 35, longitude: 136, height: 100, label: 's' },
  points: [{ id: 'sun', label: 'Sun', azimuthDegrees: 120, altitudeDegrees: 10, geometricAltitudeDegrees: 9.9, xPercent: 50, yPercent: 50, visibleInFrame: true }],
  cameraSettings: { focalLengthMm: 400, lensCenterHeightMeters: 1.6 },
  date: new Date('2026-08-29T00:00:00.000Z'),
  calculationMode: 'pro',
  previewAspectRatio: 1.5,
  refractionWeather: undefined,
  doubleCheckEnabled: false,
  initialDirectionObserver: undefined,
  accuracyMode: 'highest',
  refractionMode: 'standard',
};
const key = exactTripodCacheKey(base);
const candidate = { id: 'sun', label: 'Sun', latitude: 34.99, longitude: 135.99, height: 90, distanceMeters: 1234, solutionType: 'aligned' };
assert.equal(getExactTripodCandidates(key), null);
setExactTripodCandidates(key, [candidate]);
assert.deepEqual(getExactTripodCandidates(key), [candidate]);
assert.notEqual(exactTripodCacheKey({ ...base, date: new Date(base.date.getTime() + 1) }), key);
assert.notEqual(exactTripodCacheKey({ ...base, cameraSettings: { ...base.cameraSettings, focalLengthMm: 401 } }), key);
assert.notEqual(exactTripodCacheKey({ ...base, cameraSettings: { ...base.cameraSettings, lensCenterHeightMeters: 1.7 } }), key);
assert.notEqual(exactTripodCacheKey({ ...base, viewCorrection: { azimuthDegrees: 0.1, altitudeDegrees: 0 } }), key);
const otherKey = exactTripodCacheKey({ ...base, subject: { ...base.subject, latitude: 35.000000001 } });
assert.notEqual(otherKey, key);
setExactTripodCandidates(otherKey, [{ ...candidate, solutionType: 'preliminary' }]);
assert.equal(getExactTripodCandidates(otherKey), null);
console.log('PASS: exact session result cache only reuses strictly identical aligned inputs');

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const tileSource = readFileSync(new URL('../src/cesium/gsiDemTileCache.ts', import.meta.url), 'utf8');
const seedSource = readFileSync(new URL('../src/cesium/tripodCandidateSeedCache.ts', import.meta.url), 'utf8');
const deviceCacheSource = readFileSync(new URL('../src/cache/deviceCache.ts', import.meta.url), 'utf8');
assert.match(appSource, /refractionCorrectionMode === "standard"/);
assert.match(appSource, /loadPersistentTripodSeeds/);
assert.match(appSource, /savePersistentTripodSeeds/);
assert.match(appSource, /warmGsiDeviceTilesFromPersistentCache/);
assert.match(appSource, /const immediatePreliminaryCandidates = buildPreliminaryTripodCandidates\(/);
assert.match(appSource, /tripodCalculationInFlightRef\.current\?\.runId === runId/);
assert.match(appSource, /controller\.abort\(\);[\s\S]*?releaseInFlight\(\);/);
assert.match(appSource, /onCelestialCandidatesResolved|resolvedCandidates/);
assert.match(appSource, /三脚候補seedキャッシュを読み出せないため通常探索を続行します/);
assert.match(tileSource, /const inFlightReads = new Map/);
assert.match(tileSource, /async function readTilesBatch/);
assert.match(tileSource, /const allBases = await readTilesBatch\(allBaseRequests\)/);
assert.match(tileSource, /mustUseNetwork\.add\(index\)/);
assert.match(deviceCacheSource, /export async function getDeviceCacheMany/);
// 2026-08-29修正: 端末（PC/スマートフォン等）ごとに独立した三脚候補の
// 永続キャッシュ（IndexedDB）が、「同じプロジェクトなのに端末によって
// 結果が違う」という確認済みの問題の原因だったため、利用者からの明確な
// 指示によりこの永続キャッシュ自体を無効化した。seedSourceはもはや
// device cacheのgetDeviceCacheMany/setDeviceCacheManyを使わず、常に
// 空を返す・何も保存しないだけになっていることを確認する。
assert.doesNotMatch(seedSource, /getDeviceCacheMany/);
assert.doesNotMatch(seedSource, /setDeviceCacheMany/);
assert.match(seedSource, /export async function loadPersistentTripodSeeds/);
assert.match(seedSource, /export async function savePersistentTripodSeeds/);
console.log('PASS: persistent per-device tripod seed cache is disabled (search no longer depends on device-local history)');
console.log('PASS: interrupted tripod calculations release only their own run and progressive results stay enabled');
