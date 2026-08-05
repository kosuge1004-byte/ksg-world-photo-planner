import type { DeviceCachePolicy } from "./deviceCache";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEVICE_CACHE_POLICIES = {
  weatherForecast: { namespace: "weather-forecast-v2", ttlMs: 3 * HOUR, maxEntries: 48, memoryEntries: 16 },
  weatherClimatology: { namespace: "weather-climatology-v2", ttlMs: 30 * DAY, maxEntries: 24, memoryEntries: 8 },
  terrain: { namespace: "terrain-v3", ttlMs: 90 * DAY, maxEntries: 32_768, memoryEntries: 4_096 },
  geoid: { namespace: "geoid-v2", ttlMs: 180 * DAY, maxEntries: 4_096, memoryEntries: 512 },
  osm: { namespace: "osm-occlusion-v2", ttlMs: 14 * DAY, maxEntries: 512, memoryEntries: 64 },
} satisfies Record<string, DeviceCachePolicy>;
