import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function requireText(source, expected, message) {
  if (!source.includes(expected)) throw new Error(message);
}

const feedback = read("src/errors/userFeedback.ts");
const notice = read("src/components/UserNotice.tsx");
const app = read("src/App.tsx");
const styles = read("src/App.css");
const terrain = read("src/cesium/worldTerrain.ts");
const occlusion = read("src/cesium/celestialOcclusion.ts");
const subjectPin = read("src/cesium/subjectPin.ts");
const tripodPin = read("src/cesium/tripodPin.ts");
const weather = read("src/components/CelestialTransitSearchDialog.tsx");
const spotSearch = read("src/components/SpotSearchScreen.tsx");
const projects = read("src/projectStorage.ts");

for (const context of [
  '"spot-search"',
  '"google-maps-url"',
  '"transit-search"',
  '"highest-precision"',
  '"preview"',
  '"map"',
]) {
  requireText(feedback, context, `missing user error context ${context}`);
}
requireText(
  feedback,
  "NOTICE_DEDUPLICATION_MS",
  "repeated fallback notices are not deduplicated"
);
requireText(notice, 'aria-label="通知を閉じる"', "notice cannot be dismissed");
requireText(app, "userNotice.actionLabel ? 20_000", "notice has no automatic dismissal");
requireText(app, 'actionLabel: "再試行"', "retry action is not exposed");
requireText(app, 'actionLabel: "検索結果へ戻る"', "highest-precision recovery route is missing");
requireText(feedback, "標準精度へは変更していません", "highest precision may silently fall back");
requireText(styles, "env(safe-area-inset-top)", "notice ignores mobile safe area");
requireText(styles, "width: min(520px, calc(100% - 20px))", "notice is not viewport bounded");

for (const [source, key, label] of [
  [terrain, "gsi-dem-fallback", "DEM fallback"],
  [occlusion, "google-3d-occlusion-fallback", "Google 3D occlusion fallback"],
  [occlusion, "terrain-occlusion-failed", "terrain occlusion failure"],
  [subjectPin, "subject-pin-3d-fallback", "subject pin 3D fallback"],
  [subjectPin, "subject-pin-height-required", "subject pin terrain fallback"],
  [tripodPin, "tripod-pin-3d-fallback", "tripod pin 3D fallback"],
  [tripodPin, "tripod-pin-height-required", "tripod pin terrain fallback"],
  [weather, "weather-refraction-fallback", "weather fallback"],
  [projects, "project-storage-failed", "project storage failure"],
]) {
  requireText(source, key, `${label} is not communicated to the user`);
}

requireText(
  terrain,
  "return points.map(() => ({ heightMeters: null, source: null }))",
  "DEM fallback behavior changed"
);
requireText(
  occlusion,
  "...demOnlyResult",
  "Google 3D failure no longer preserves the DEM result"
);
requireText(
  weather,
  'throw new Error("高精度の気象データを取得できませんでした")',
  "highest precision silently accepts weather fallback"
);
requireText(
  spotSearch,
  '"google-maps-url"',
  "Google Maps URL errors are not translated separately"
);
requireText(
  spotSearch,
  '"被写体を検索して表示"',
  "spot-search retry operation is unavailable"
);

console.log("User error handling and fallback verification: PASS");
