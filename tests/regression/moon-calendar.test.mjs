import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findHorizonCrossing } from "../../src/cesium/celestial.ts";
import { findMoonriseOnDate, isDateKey, nextDateKey } from "../../src/time/moonrise.ts";
import { dateFromZonedDateTimeLocal, zonedDateTimeLocalFromDate } from "../../src/time/zonedTime.ts";

const timeZone = "Asia/Tokyo";
const keyOf = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

test("calendar moonrise equals the timeline's moonrise for every day, including days without one", () => {
  let withMoonrise = 0;
  let withoutMoonrise = 0;
  for (const location of [
    { latitude: 35.3445, longitude: 136.787, height: 0, label: "地図の表示位置" },
    { latitude: 43.06, longitude: 141.35, height: 0, label: "地図の表示位置" },
    { latitude: 26.21, longitude: 127.68, height: 0, label: "地図の表示位置" },
  ]) {
    const input = { location, timeZone, calculationMode: "standard" };
    for (let day = 1; day <= 31; day += 1) {
      const key = keyOf(2026, 10, day);
      const fast = findMoonriseOnDate(input, key);
      // タイムラインの「月出」と同じ求め方（2分刻みの走査）。
      const reference = findHorizonCrossing(
        "moon", 1, location,
        dateFromZonedDateTimeLocal(`${key}T00:00`, timeZone),
        dateFromZonedDateTimeLocal(`${nextDateKey(key)}T00:00`, timeZone),
        "standard"
      );
      if (reference === null) {
        assert.equal(fast, null, `${key}: 月の出が無い日`);
        withoutMoonrise += 1;
      } else {
        assert.ok(fast, `${key}: 月の出あり`);
        assert.ok(
          Math.abs(fast.getTime() - reference.getTime()) < 2_000,
          `${key}: ${fast.toISOString()} vs ${reference.toISOString()}`
        );
        // その日の中の時刻であること（前後の日の月の出へ飛ばない）。
        assert.equal(zonedDateTimeLocalFromDate(fast, timeZone).slice(0, 10), key);
        withMoonrise += 1;
      }
    }
  }
  assert.ok(withMoonrise >= 87, `with ${withMoonrise}`);
  assert.ok(withoutMoonrise >= 3, "約1か月に1日、月の出が無い日がある");
});

test("moonrise needs a location and a valid date key; the place changes the time", () => {
  const base = { timeZone, calculationMode: "standard" };
  assert.equal(findMoonriseOnDate({ ...base, location: null }, "2026-10-20"), null);
  const gifu = { latitude: 35.3445, longitude: 136.787, height: 0, label: "a" };
  assert.equal(findMoonriseOnDate({ ...base, location: gifu }, "2026/10/20"), null);
  assert.equal(isDateKey("2026-10-20"), true);
  assert.equal(isDateKey("2026-10-2"), false);
  assert.equal(nextDateKey("2026-10-31"), "2026-11-01");
  assert.equal(nextDateKey("2026-12-31"), "2027-01-01");
  assert.equal(nextDateKey("2028-02-28"), "2028-02-29");
  // 那覇（南西へ約1,300km）では、月の出の時刻が10分以上違う。
  const here = findMoonriseOnDate({ ...base, location: gifu }, "2026-10-20");
  const naha = findMoonriseOnDate({ ...base, location: { ...gifu, latitude: 26.21, longitude: 127.68 } }, "2026-10-20");
  assert.ok(Math.abs(here.getTime() - naha.getTime()) > 10 * 60_000);
});

test("tapping a day only selects it; a separate button jumps, and a today button exists", async () => {
  const calendar = await readFile(new URL("../../src/components/MoonAgeCalendarScreen.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  // 日付を押しても移動しない（選ぶだけ）。
  assert.match(calendar, /onClick=\{\(\) => setSelectedKey\(day\.key\)\}/);
  assert.equal((calendar.match(/onJumpToDate\(/g) ?? []).length, 1, "移動は専用ボタンの1か所だけ");
  assert.match(calendar, /className="moon-day-jump" onClick=\{\(\) => onJumpToDate\(selected\.key\)\}/);
  // 各マスに月の出の時刻。月の出が無い日は「—」。
  assert.match(calendar, /className="moon-rise-time">\{day\.moonriseTime \? `出 \$\{day\.moonriseTime\}` : "出 —"\}/);
  assert.match(calendar, /findMoonriseOnDate\(moonriseInput, key\)/);
  // 今日へ戻る: 今日の月を表示し、今日を選ぶ（アプリのタイムゾーンで）。
  assert.match(calendar, /function showToday\(\): void \{\s*const todayKey = zonedDateKey\(new Date\(\), timeZone\);\s*setMonth\(monthStartOf\(todayKey\)\);\s*setSelectedKey\(todayKey\);/);
  assert.match(calendar, /className="moon-calendar-today" onClick=\{showToday\}/);
  // 選んだ日が表示中の月に無いときは、別の日を黙って移動先にしない。
  assert.match(calendar, /days\.find\(\(day\) => day\.key === selectedKey\) \?\? null/);

  // 月の出を求める地点は、カレンダーを開いた時に地図で表示していた場所（3Dは画面中央）。
  assert.match(app, /function openMoonAgeCalendar\(\): void \{[\s\S]*?mapDisplayMode === "3d"[\s\S]*?get3dMapCenter\(viewer\) \?\? mapCenterRef\.current[\s\S]*?setMoonCalendarLocation\(/);
  assert.match(app, /onOpenMoonAgeCalendar=\{openMoonAgeCalendar\}/);
  assert.match(app, /moonriseInput=\{moonCalendarMoonriseInput\}/);
  // 表示と移動先は同じ関数・同じ入力。
  assert.match(app, /const moonrise = findMoonriseOnDate\(input\.moonrise, dateKey\);/);
  assert.match(app, /setDateTimeLocal\(zonedDateTimeLocalFromDate\(moonrise, input\.moonrise\.timeZone\)\)/);
  // 月の出が無い日は日付だけ移動し、黙って別の日の月の出へ飛ばない。
  assert.match(app, /月の出がありません/);
});
