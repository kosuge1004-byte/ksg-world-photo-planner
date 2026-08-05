import fs from "node:fs";
const cache = fs.readFileSync("src/cache/deviceCache.ts", "utf8");
const policies = fs.readFileSync("src/cache/cachePolicies.ts", "utf8");
const weather = fs.readFileSync("src/search/refractionWeather.ts", "utf8");
const checks = [
  [cache.includes('astrosight-device-cache-v1'), '共通IndexedDB'],
  [cache.includes('expiresAt') && cache.includes('pruneNamespace'), 'TTLと容量整理'],
  [cache.includes('migrateLegacyLocalStorage'), '旧localStorage移行'],
  [policies.includes('weatherForecast') && policies.includes('terrain') && policies.includes('geoid') && policies.includes('osm'), 'API別ポリシー'],
  [weather.includes('getDeviceCache') && weather.includes('migrateLegacyLocalStorage') && weather.includes('setDeviceCache'), '気象キャッシュ移行'],
  [!weather.includes('WEATHER_CACHE_MAX_ENTRIES'), '旧個別整理処理の除去'],
];
const failed = checks.filter(([ok]) => !ok);
for (const [ok, name] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
