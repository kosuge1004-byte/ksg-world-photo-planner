import { findHorizonCrossing } from "../cesium/celestial";
import type { RefractionWeatherContext } from "../search/refractionWeather";
import type { CalculationMode } from "../types/camera";
import type { GroundPoint } from "../types/points";
import { dateFromZonedDateTimeLocal } from "./zonedTime";

/**
 * 2026-10-09: 月齢カレンダーに出す「その日の月の出」。
 * カレンダーの表示と「この日の月の出へ移動」で同じ関数を使い、表示した時刻と
 * 移動先の時刻が食い違わないようにする。
 *
 * 求め方はタイムラインの「月出」と同じ（その日の0時〜翌0時で最初に昇る時刻。
 * 月の中心の高度が0度を上向きに横切る瞬間）。約1か月に1日ある「月の出が無い日」はnull。
 */
export type MoonriseInput = {
  location: GroundPoint | null;
  timeZone: string;
  calculationMode: CalculationMode;
  refractionWeather?: RefractionWeatherContext;
};

// 1か月ぶん（最大31日）をまとめて求めるため、走査は20分刻みにする。月の出と月の入りは
// 半日ほど離れているので、20分の中に両方が入ることはなく、求まる時刻は2分刻みと同じ。
const MOONRISE_SCAN_STEP_MS = 20 * 60_000;

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export function findMoonriseOnDate(input: MoonriseInput, dateKey: string): Date | null {
  if (!input.location || !isDateKey(dateKey)) return null;
  const nextKey = nextDateKey(dateKey);
  return findHorizonCrossing(
    "moon",
    1,
    input.location,
    dateFromZonedDateTimeLocal(`${dateKey}T00:00`, input.timeZone),
    dateFromZonedDateTimeLocal(`${nextKey}T00:00`, input.timeZone),
    input.calculationMode,
    input.refractionWeather,
    MOONRISE_SCAN_STEP_MS
  );
}
