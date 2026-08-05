import fs from 'node:fs';

const celestial = fs.readFileSync(new URL('../src/cesium/celestialOcclusion.ts', import.meta.url), 'utf8');
const device = fs.readFileSync(new URL('../src/cache/deviceCache.ts', import.meta.url), 'utf8');
const lru = fs.readFileSync(new URL('../server/lruPromiseCache.ts', import.meta.url), 'utf8');

const checks = [
  ['client promise cache updates LRU order on hit', celestial.includes('function boundedPromiseCacheGet') && celestial.includes('cache.delete(key);\n  cache.set(key, value);')],
  ['terrain cache uses bounded LRU helper', celestial.includes('boundedPromiseCacheGet(terrainHorizonCache, key)') && celestial.includes('MAX_TERRAIN_CACHE_ENTRIES')],
  ['mesh and observer caches use LRU reads', (celestial.match(/boundedPromiseCacheGet\(viewerCache, key\)/g) ?? []).length >= 2],
  ['device cache pruning is throttled', device.includes('PRUNE_INTERVAL_MS = 60_000') && device.includes('scheduleNamespacePrune(policy)')],
  ['device cache prune requests are deduplicated', device.includes('namespacePruneInFlight') && device.includes('const existing = namespacePruneInFlight.get(policy.namespace)')],
  ['server LRU removes expired entries during trim', lru.includes('for (const [key, entry] of this.entries)') && lru.includes('now - entry.touchedAt > this.options.ttlMs')],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
