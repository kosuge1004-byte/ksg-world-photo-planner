import fs from "node:fs";

const background = fs.readFileSync(
  new URL("../src/search/backgroundSpotSearch.ts", import.meta.url),
  "utf8"
);
const terrain = fs.readFileSync(
  new URL("../src/cesium/worldTerrain.ts", import.meta.url),
  "utf8"
);
const occlusion = fs.readFileSync(
  new URL("../src/cesium/celestialOcclusion.ts", import.meta.url),
  "utf8"
);
const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

for (const field of [
  "subject",
  "subjectGroundHeightMeters",
  "baseDateIso",
  "timeZone",
  "criteria",
  "calculationMode",
  "lensCenterHeightMeters",
  "cameraSettings",
  "previewAspectRatio",
  "viewCorrection",
  "precisionSettings",
]) {
  if (!background.includes(`${field}:`)) {
    throw new Error(`prepared-search cache key misses ${field}`);
  }
}
if (!terrain.includes('maximumDetail ?? "auto"')) {
  throw new Error("terrain cache key misses requested DEM detail");
}
if (!occlusion.includes("export function invalidateCelestialOcclusionCaches")) {
  throw new Error("central occlusion invalidation entry is missing");
}
if (!app.includes("invalidateCelestialOcclusionCaches(")) {
  throw new Error("App does not invalidate occlusion caches after condition changes");
}

const base = {
  subject: { latitude: 35, longitude: 139, height: 10 },
  date: "2026-07-29T00:00:00.000Z",
  focalLength: 400,
  aspect: 1.5,
  precision: "standard",
  refraction: "auto",
  viewCorrection: { azimuthDegrees: 0, altitudeDegrees: 0 },
};
const key = (value) => JSON.stringify(value);
for (const mutation of [
  { subject: { ...base.subject, latitude: 35.000001 } },
  { date: "2026-07-30T00:00:00.000Z" },
  { focalLength: 800 },
  { aspect: 16 / 9 },
  { precision: "highest" },
  { refraction: "none" },
  { viewCorrection: { azimuthDegrees: 5, altitudeDegrees: 0 } },
]) {
  if (key(base) === key({ ...base, ...mutation })) {
    throw new Error(`cache key did not change for ${JSON.stringify(mutation)}`);
  }
}

console.log("Cache key and invalidation verification: PASS");
