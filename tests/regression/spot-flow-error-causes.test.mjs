import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bearingProfilesCoverSearchRange } from "../../src/cache/tripodBearingProfileManager.ts";
import { nominatimRequestHeaders } from "../../server/placeGeocode.ts";

const profile = (lastDistanceMeters) => ({
  points: [8, 100, lastDistanceMeters].map((distanceMeters) => ({
    distanceMeters, latitude: 35, longitude: 139, ellipsoidalHeightMeters: 40,
  })),
});

test("saved sections are used for the fast path only when they reach the search range", () => {
  // 10kmぶん保存・探索上限10km: 使う（末尾の丸め誤差は許容）。
  assert.equal(bearingProfilesCoverSearchRange([profile(10_000), profile(9_999.995)], 10_000), true);
  // 10kmぶん保存・探索上限20km: 10kmより遠くに本来の候補があり得るので使わない。
  assert.equal(bearingProfilesCoverSearchRange([profile(10_000), profile(10_000)], 20_000), false);
  // 1方位でも届いていなければ使わない。
  assert.equal(bearingProfilesCoverSearchRange([profile(20_000), profile(10_000)], 20_000), false);
  // 範囲が長い分には問題ない（富士山の100kmを10km設定で使う等）。
  assert.equal(bearingProfilesCoverSearchRange([profile(100_000)], 10_000), true);
  // 探索上限が渡されない呼び出しは従来どおり。
  assert.equal(bearingProfilesCoverSearchRange([profile(10_000)], undefined), true);
  assert.equal(bearingProfilesCoverSearchRange([null], 10_000), false);
});

test("built-in spots save the published data first when the search distance exceeds its range", async () => {
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("async function confirmBearingProfileDownload");
  const body = app.slice(start, app.indexOf("function cancelBearingProfileDownload", start));
  // 設定距離が計算済みデータの範囲を超える内蔵スポットだけが対象。
  assert.match(body, /requestedMaxDistanceMeters > precomputedTarget\.maxDistanceMeters \+ 0\.01/);
  // 1) 設定距離ぶんをサーバーから（1方位ずつの直接取得には進まない）。
  assert.match(body, /maxDistanceMeters: requestedMaxDistanceMeters,\s*forceRefresh,\s*allowDirectFallback: false,/);
  // 2) 得られなければ計算済みデータの範囲で保存。1)で保存できた方位は消さない。
  assert.match(body, /maxDistanceMeters: precomputedRangeMeters,\s*forceRefresh: false,\s*allowDirectFallback: false,/);
  // 3) 計算済みデータも無ければ、従来どおり直接取得で設定距離ぶんを集める。
  assert.match(body, /backfillResult = await runBackfill\(\{ maxDistanceMeters: requestedMaxDistanceMeters, forceRefresh: false \}\);/);
  // 範囲が限られたことを伝え、設定距離まで直接取得するかは利用者が選ぶ。
  assert.match(body, /の計算済みデータ（\$\{savedKm\}kmまで）を保存しました。/);
  assert.match(body, /actionLabel: `\$\{settingKm\}kmまで直接取得する（時間がかかります）`/);
  assert.match(body, /allowSlowDirectDownload: true,/);
  // 対象外（設定が範囲内・内蔵スポット以外・利用者が直接取得を選んだ場合）は従来と同じ1回の取得。
  assert.match(body, /\} else \{\s*backfillResult = await runBackfill\(\{ maxDistanceMeters: requestedMaxDistanceMeters, forceRefresh \}\);/);
  // 三脚候補の高速経路には、通常探索と同じ探索上限を渡す。
  assert.match(app, /await tryUseBearingProfileCache\([\s\S]*?controller\.signal,[\s\S]*?registeredProfileCoverageDistanceMeters\(\s*subjectPoint\.latitude,\s*subjectPoint\.longitude,\s*precisionSettings\.tripodSearchMaxDistanceMeters\s*\)\s*\);/);
});

test("Nominatim gets the app User-Agent from the server only, never from a browser", () => {
  assert.deepEqual(nominatimRequestHeaders(false), {
    Accept: "application/json",
    "Accept-Language": "ja-JP,ja;q=0.9",
    "User-Agent": "AstroSight/1.0",
  });
  // ブラウザからは、事前確認なしで送れるヘッダーだけにする。
  assert.deepEqual(nominatimRequestHeaders(true), {
    Accept: "application/json",
    "Accept-Language": "ja-JP,ja;q=0.9",
  });
  // この検査（Node.js）は document が無いのでサーバー扱い。
  assert.equal("User-Agent" in nominatimRequestHeaders(), true);
});

test("a failed history save no longer fails the pin placement", async (t) => {
  const original = globalThis.localStorage;
  t.after(() => { globalThis.localStorage = original; });
  let reads = 0;
  globalThis.localStorage = {
    getItem: () => { reads += 1; return null; },
    setItem: () => { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); },
  };
  const { addSubjectHistory } = await import("../../src/subjectStorage.ts");
  const point = { latitude: 35.6586, longitude: 139.7454, height: 370, label: "東京タワー" };
  const history = addSubjectHistory(point, "place");
  // 保存できなくても例外にせず、この回の履歴を返す（呼び出し側は処理を続けられる）。
  assert.equal(history.length, 1);
  assert.equal(history[0].label, "東京タワー");
  assert.equal(history[0].searchType, "place");
  assert.ok(reads >= 1);
});
