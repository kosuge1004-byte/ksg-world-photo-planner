import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const app = read("src/App.tsx");
const policy = read("src/celestial/terrainOcclusionPolicy.ts");
const occlusion = read("src/cesium/celestialOcclusion.ts");
const overlay = read("src/components/CelestialOverlay.tsx");

const invalidationStart = app.indexOf("// 遮蔽キャッシュは観測地点・日時・大気条件が変わった場合だけ無効化する。");
const invalidationEnd = app.indexOf("const milkyWayPath", invalidationStart);
if (invalidationStart < 0 || invalidationEnd < 0) {
  throw new Error("occlusion cache invalidation effect was not found");
}
const invalidationEffect = app.slice(invalidationStart, invalidationEnd);
for (const projectionOnlyDependency of [
  "cameraSettings.focalLengthMm",
  "previewAspectRatio",
  "previewViewCorrection",
]) {
  if (invalidationEffect.includes(projectionOnlyDependency)) {
    throw new Error(`projection-only change still invalidates line of sight: ${projectionOnlyDependency}`);
  }
}

for (const expected of [
  "celestialOcclusionDirections",
  "calculateCelestialHorizontalCoordinates(",
  "// 焦点距離・画角・構図補正は水平座標を変えないため依存させない。",
  "celestialOcclusionDirections.length === 0",
  "!celestialVisibility.milkyWay",
  "milkyWayPath.length === 0",
]) {
  if (!app.includes(expected)) {
    throw new Error(`stable occlusion recalculation wiring is missing: ${expected}`);
  }
}
for (const guard of [
  "if (cancelled || controller.signal.aborted) return;",
  "controller.abort();",
  "window.clearTimeout(timer);",
]) {
  if (!app.includes(guard)) throw new Error(`stale-response guard is missing: ${guard}`);
}

for (const expected of [
  "TERRAIN_OCCLUSION_UNCERTAINTY_DEGREES = 0.015",
  'status: "obstructed"',
  'status: "uncertain"',
  'status: "visible"',
]) {
  if (!policy.includes(expected)) throw new Error(`terrain boundary policy is missing: ${expected}`);
}
for (const expected of [
  "classifyTerrainOcclusion(",
  "terrainBoundaryUncertain",
  "terrainClearanceDegrees",
  'reason: terrainObstructed',
]) {
  if (!occlusion.includes(expected)) throw new Error(`terrain decision diagnostics are missing: ${expected}`);
}
for (const attribute of [
  "data-occlusion-moon-apparent-altitude",
  "data-occlusion-moon-geometric-altitude",
  "data-occlusion-moon-terrain-elevation",
  "data-occlusion-moon-terrain-clearance",
  "data-occlusion-moon-obstruction-distance",
  "data-occlusion-moon-terrain-source",
  "data-occlusion-moon-failure",
]) {
  if (!overlay.includes(attribute)) throw new Error(`moon occlusion diagnostic is missing: ${attribute}`);
}

console.log(JSON.stringify({
  focalLengthDoesNotRecalculateBodyOcclusion: true,
  timelineStillRecalculatesAfterInteraction: true,
  staleAsyncResultsRejected: true,
  terrainBoundaryUncertaintyDegrees: 0.015,
  moonOcclusionDiagnostics: true,
}));
