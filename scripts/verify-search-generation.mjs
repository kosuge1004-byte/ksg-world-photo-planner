import fs from "node:fs";

const spot = fs.readFileSync(
  new URL("../src/components/SpotSearchScreen.tsx", import.meta.url),
  "utf8"
);
const transit = fs.readFileSync(
  new URL("../src/components/CelestialTransitSearchDialog.tsx", import.meta.url),
  "utf8"
);

if (!transit.includes("searchGenerationRef")) {
  throw new Error("transit search has no search generation");
}
if (!transit.includes("searchGenerationRef.current !== searchGeneration")) {
  throw new Error("transit search does not reject stale completions");
}
if (!transit.includes("controller.signal.aborted")) {
  throw new Error("transit search does not reject cancelled updates");
}

// スポット検索は場所検索だけになり、長時間の日時・構図探索を行わない。
// 連続検索では前のAbortControllerを止め、旧progressを反映しないことを確認する。
for (const expected of [
  "controllerRef.current?.abort()",
  "controller.signal.aborted",
  "controllerRef.current === controller",
]) {
  if (!spot.includes(expected)) {
    throw new Error(`place search cancellation guard is missing: ${expected}`);
  }
}
if (spot.includes("日時・構図候補も検索")) {
  throw new Error("removed date/composition search is still exposed in spot search");
}

let latest = 0;
const applied = [];
const start = () => ++latest;
const apply = (id, value) => {
  if (id === latest) applied.push(value);
};
const oldId = start();
const newId = start();
apply(newId, "new-progress");
apply(oldId, "old-progress");
apply(oldId, "old-result");
apply(newId, "new-result");
if (applied.join(",") !== "new-progress,new-result") {
  throw new Error(`stale search update was applied: ${applied.join(",")}`);
}

console.log("Search generation race verification: PASS");
