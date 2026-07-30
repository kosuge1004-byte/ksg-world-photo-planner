import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function requireText(source, expected, message) {
  if (!source.includes(expected)) throw new Error(message);
}

const viewer = read("src/cesium/createMapViewer.ts");
const app = read("src/App.tsx");
const background = read("src/search/backgroundSpotSearch.ts");
const osm = read("server/osmSiteContext.ts");
const terrain = read("src/cesium/worldTerrain.ts");
const zonedTime = read("src/time/zonedTime.ts");
const weather = read("src/search/refractionWeather.ts");
const occlusion = read("src/cesium/celestialOcclusion.ts");
const preparedSearch = read("src/search/preparedSearchCache.ts");
const overlay = read("src/components/CelestialOverlay.tsx");
const timeline = read("src/components/TimelinePanel.tsx");

requireText(viewer, "requestRenderMode: true", "Cesium request-render mode is disabled");
requireText(
  viewer,
  "maximumRenderTimeChange: Number.POSITIVE_INFINITY",
  "Cesium still performs periodic time-driven renders"
);
requireText(
  app,
  'if (mapViewMode !== "3d") return;',
  "hidden Cesium entities are still updated in 2D mode"
);
requireText(
  app,
  "current.width === width && current.height === height",
  "map ResizeObserver still commits identical state"
);
requireText(
  app,
  "current === nextAspectRatio ? current : nextAspectRatio",
  "preview ResizeObserver still commits identical state"
);
requireText(
  app,
  "onOpenTransitSearch={openCelestialTransitSearch}",
  "timeline receives an unstable inline open callback"
);

for (const [source, label] of [
  [background, "background spot-search delay"],
  [osm, "OSM retry delay"],
]) {
  requireText(
    source,
    'removeEventListener("abort", onAbort)',
    `${label} does not release its abort listener`
  );
  requireText(
    source,
    "if (signal?.aborted)",
    `${label} does not reject an already-aborted signal`
  );
}

for (const [source, expected, label] of [
  [terrain, "TERRAIN_MEMORY_CACHE_MAX_ENTRIES", "terrain memory cache"],
  [terrain, "GEOID_MEMORY_CACHE_MAX_ENTRIES", "geoid memory cache"],
  [zonedTime, "FORMATTER_CACHE_MAX_ENTRIES", "timezone formatter cache"],
  [weather, "WEATHER_CACHE_MAX_ENTRIES", "weather storage cache"],
  [occlusion, "MAX_TERRAIN_CACHE_ENTRIES", "occlusion terrain cache"],
  [occlusion, "MAX_MESH_LINE_OF_SIGHT_CACHE_ENTRIES", "3D line-of-sight cache"],
  [preparedSearch, "MAX_ENTRIES", "prepared-search cache"],
]) {
  requireText(source, expected, `${label} has no explicit upper bound`);
}
requireText(terrain, "writeMemoryCache(", "bounded terrain/geoid cache writer is missing");
requireText(overlay, "memo(CelestialOverlayComponent)", "celestial overlay is not memoized");
requireText(timeline, "memo(TimelinePanelComponent)", "timeline panel is not memoized");

function boundedSet(cache, key, value, maximumEntries) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

const cache = new Map();
for (let index = 0; index < 10_000; index += 1) {
  boundedSet(cache, `point-${index}`, index, 128);
}
if (cache.size !== 128 || cache.has("point-0") || !cache.has("point-9999")) {
  throw new Error("bounded cache eviction simulation failed");
}

console.log("Performance and lifecycle verification: PASS");
