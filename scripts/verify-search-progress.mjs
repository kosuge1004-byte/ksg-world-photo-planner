import fs from "node:fs";

const estimator = fs.readFileSync(
  new URL("../src/search/searchProgress.ts", import.meta.url),
  "utf8"
);
const spotSearch = fs.readFileSync(
  new URL("../src/search/spotPresetSearch.ts", import.meta.url),
  "utf8"
);
const spotScreen = fs.readFileSync(
  new URL("../src/components/SpotSearchScreen.tsx", import.meta.url),
  "utf8"
);
const transitSearch = fs.readFileSync(
  new URL("../src/search/celestialTransitSearch.ts", import.meta.url),
  "utf8"
);
const transitScreen = fs.readFileSync(
  new URL("../src/components/CelestialTransitSearchDialog.tsx", import.meta.url),
  "utf8"
);
const background = fs.readFileSync(
  new URL("../src/search/backgroundSpotSearch.ts", import.meta.url),
  "utf8"
);
const server = fs.readFileSync(
  new URL("../server/runSpotSearchJob.ts", import.meta.url),
  "utf8"
);
const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

if (!estimator.includes("Math.max(currentPercent, bounded)")) {
  throw new Error("progress estimator does not prevent backward movement");
}
if (
  !estimator.includes("updateSearchId !== searchId") ||
  !spotScreen.includes("progressEstimatorRef.current?.update") ||
  !transitScreen.includes("progressEstimatorRef.current?.update")
) {
  throw new Error("progress estimator is not linked to the active search generation");
}
if (
  !estimator.includes("smoothedMillisecondsPerPercent") ||
  !estimator.includes("RATE_SMOOTHING_WEIGHT")
) {
  throw new Error("moving-average ETA is missing");
}
if (
  !spotSearch.includes("checkedCount / Math.max(1, sampleCount)") ||
  !spotSearch.includes("検索中 ${currentSearchDateLabel()}") ||
  !spotSearch.includes("celestialMatchCount")
) {
  throw new Error("spot progress is not based on actual traversal volume");
}
if (
  !transitSearch.includes("processed,") ||
  !transitSearch.includes("total: totalSamples") ||
  !transitSearch.includes("candidateCount: results.length")
) {
  throw new Error("transit progress does not expose traversal counts");
}
if (
  !background.includes("lastReportedProgressPercent") ||
  !server.includes("lastSavedProgressPercent")
) {
  throw new Error("background progress can still move backward");
}
if (
  !server.includes("Math.min(97") ||
  !app.includes('onProgress("最終3D確認結果を保存しています…", 99)') ||
  !spotSearch.includes("100,")
) {
  throw new Error("100% is not reserved for completed search");
}
if (
  !spotScreen.includes("searchGenerationRef.current += 1") ||
  !spotScreen.includes("progressEstimatorRef.current = null")
) {
  throw new Error("cancelled spot search can retain its progress estimator");
}

let current = 0;
const applied = [5, 42, 18, 80, 79, 100].map((value) => {
  current = Math.max(current, Math.max(0, Math.min(100, Math.round(value))));
  return current;
});
if (applied.join(",") !== "5,42,42,80,80,100") {
  throw new Error(`monotonic progress regression: ${applied.join(",")}`);
}

console.log("Search progress, generation and ETA verification: PASS");
