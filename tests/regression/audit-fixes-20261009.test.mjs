import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { anySignal, timeoutSignal } from "../../src/network/abortSignals.ts";
import { buildRiseSetArcTimeline, findCarryOverRiseSetPass } from "../../src/cesium/tripodCandidateRiseSetArc.ts";
import { searchJapanesePlaceCandidates } from "../../server/placeGeocode.ts";
import { dateFromZonedDateTimeLocal } from "../../src/time/zonedTime.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("abort signals work on devices without AbortSignal.any / AbortSignal.timeout", async () => {
  const original = { any: AbortSignal.any, timeout: AbortSignal.timeout };
  try {
    AbortSignal.any = undefined;
    AbortSignal.timeout = undefined;
    const user = new AbortController();
    const combined = anySignal([user.signal, timeoutSignal(60_000)]);
    assert.equal(combined.aborted, false);
    user.abort(new Error("stop"));
    assert.equal(combined.aborted, true);
    assert.equal(combined.reason.message, "stop");
    const timed = timeoutSignal(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(timed.aborted, true);
    assert.equal(timed.reason.name, "TimeoutError");
    const already = new AbortController();
    already.abort();
    assert.equal(anySignal([already.signal]).aborted, true);
  } finally {
    AbortSignal.any = original.any;
    AbortSignal.timeout = original.timeout;
  }
  for (const path of ["src/network/networkDiagnostics.ts", "src/cesium/worldTerrain.ts", "src/search/spotPresetSearch.ts"]) {
    assert.doesNotMatch(await read(path), /AbortSignal\.(any|timeout)\(/, path);
  }
});

test("the candidate line can follow the moon that is already up after midnight", () => {
  const subject = { latitude: 35.3445, longitude: 136.787, height: 60, label: "a" };
  const base = { id: "moon", subject, lensCenterHeightMeters: 1.5, calculationMode: "standard", maxDistanceMeters: 10_000 };
  let carried = 0;
  for (let day = 1; day <= 28; day += 1) {
    const key = `2026-10-${String(day).padStart(2, "0")}`;
    const dayStart = dateFromZonedDateTimeLocal(`${key}T00:00`, "Asia/Tokyo");
    const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);
    const carryOver = findCarryOverRiseSetPass({ ...base, dayStart });
    const dayLine = buildRiseSetArcTimeline({ ...base, dayStart, dayEnd });
    const carryLine = buildRiseSetArcTimeline({ ...base, dayStart, dayEnd, pass: "carryOver" });
    if (!carryOver) {
      // 0時に月が出ていない日は、従来と同じ線。
      assert.equal(carryLine?.riseAt.getTime(), dayLine?.riseAt.getTime(), key);
      continue;
    }
    carried += 1;
    assert.ok(carryOver.riseAt < dayStart && carryOver.setAt > dayStart, key);
    assert.equal(carryLine.riseAt.getTime(), carryOver.riseAt.getTime(), key);
    assert.equal(carryLine.setAt.getTime(), carryOver.setAt.getTime(), key);
    // 従来の線は、その日のうちに昇る回（0時より後）だった。
    if (dayLine && dayLine.riseAt >= dayStart) assert.notEqual(dayLine.riseAt.getTime(), carryLine.riseAt.getTime(), key);
  }
  assert.ok(carried >= 8, `carried ${carried}`);
});

test("number-only input is not sent to Photon; English region names are shown in Japanese", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).includes("photon")) {
      return new Response(JSON.stringify({ features: [{
        geometry: { type: "Point", coordinates: [139.7454, 35.6586] },
        properties: { name: "東京タワー", countrycode: "JP", state: "Tokyo", city: "Minato", osm_key: "tourism", osm_value: "attraction" },
      }] }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  await searchJapanesePlaceCandidates("138", { mode: "suggest" }, undefined, fetcher).catch(() => []);
  assert.equal(calls.filter((url) => url.includes("photon")).length, 0);
  const result = await searchJapanesePlaceCandidates("東京タワー", { mode: "suggest" }, undefined, fetcher);
  const candidate = result.find((item) => item.name === "東京タワー");
  assert.ok(candidate);
  assert.match(candidate.detail, /東京都/);
  assert.doesNotMatch(`${candidate.detail} ${candidate.label}`, /Tokyo|Minato/);
});

test("storage failures, stale shell files and the misleading retry message", async () => {
  for (const path of ["src/App.tsx", "src/cache/downloadedSpotData.ts", "src/cache/tripodBearingProfileManager.ts",
    "src/search/searchUiPreferences.ts", "src/search/backgroundSpotSearch.ts"]) {
    assert.doesNotMatch(await read(path), /localStorage\.setItem\(/, path);
  }
  const sw = await read("public/sw.js");
  assert.match(sw, /asset-manifest\.json/);
  assert.match(sw, /if \(windows\.length > 1\) return;/);
  assert.match(await read("vite.config.ts"), /asset-manifest\.json/);
  assert.doesNotMatch(await read("functions/api/bearing-profile-batch.ts"), /接続回復後に自動再試行/);
});
