import type { DeviceCachePolicy } from "./deviceCache";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEVICE_CACHE_POLICIES = {
  weatherForecast: { namespace: "weather-forecast-v2", ttlMs: 3 * HOUR, maxEntries: 48, memoryEntries: 16 },
  // 過去日の気象は同じ日時・地点なら再取得しても値がほぼ変わらないため長期保持する。
  // 範囲キーを含めるので、1日表示と長期間検索のキャッシュが衝突しない。
  weatherHistorical: { namespace: "weather-historical-v1", ttlMs: 180 * DAY, maxEntries: 96, memoryEntries: 24 },
  weatherClimatology: { namespace: "weather-climatology-v2", ttlMs: 30 * DAY, maxEntries: 24, memoryEntries: 8 },
  terrain: { namespace: "terrain-v3", ttlMs: 90 * DAY, maxEntries: 32_768, memoryEntries: 4_096 },
  geoid: { namespace: "geoid-v2", ttlMs: 180 * DAY, maxEntries: 4_096, memoryEntries: 512 },
  osm: { namespace: "osm-occlusion-v2", ttlMs: 14 * DAY, maxEntries: 512, memoryEntries: 64 },
} satisfies Record<string, DeviceCachePolicy>;
