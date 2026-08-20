import fs from "node:fs";

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function requireText(source, expected, message) {
  if (!source.includes(expected)) throw new Error(message);
}

function requireAbsence(source, key, noticeCallName, message) {
  // 単なる文字列としての出現ではなく、「そのキーが通知呼び出しの一部として
  // 使われていないこと」を確認する（コメント内の言及等は許容する）。
  const pattern = new RegExp(
    `${noticeCallName}\\s*\\(\\s*\\{[^}]*key:\\s*["']${key}["']`,
    "s"
  );
  if (pattern.test(source)) throw new Error(message);
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
requireText(feedback, "標準モードへは変更していません", "highest precision may silently fall back");
requireText(styles, "env(safe-area-inset-top)", "notice ignores mobile safe area");
requireText(styles, "width: min(520px, calc(100% - 20px))", "notice is not viewport bounded");

for (const [source, key, label] of [
  [terrain, "gsi-dem-fallback", "DEM fallback"],
  [subjectPin, "subject-pin-3d-fallback", "subject pin 3D fallback"],
  [subjectPin, "subject-pin-height-required", "subject pin terrain fallback"],
  [tripodPin, "tripod-pin-3d-fallback", "tripod pin 3D fallback"],
  [tripodPin, "tripod-pin-height-required", "tripod pin terrain fallback"],
  [weather, "weather-refraction-fallback", "weather fallback"],
  [projects, "project-storage-failed", "project storage failure"],
]) {
  requireText(source, key, `${label} is not communicated to the user`);
}
// 天体の遮蔽判定（地形・Google 3D）失敗は、指示によりプレビュー画面へ
// ポップアップ・エラー表示しない方針にした（判定ロジック自体は維持し、
// 未検証状態として静かにフォールバックする）。誤って復活しないよう、
// 通知していないことを明示的に確認する。
requireAbsence(occlusion, "terrain-occlusion-failed", "showUserNotice", "terrain occlusion failure notice was reintroduced");
requireAbsence(app, "celestial-occlusion", "showUserNotice", "celestial occlusion notice was reintroduced");

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
  'throw new Error("Googleタイルモードで必要な気象データを取得できませんでした")',
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
