import { zonedDateTimeLocalFromDate } from "../time/zonedTime";

export const DEFAULT_SEARCH_START_TIME = "00:00";
export const DEFAULT_SEARCH_END_TIME = "23:59";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidSearchTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function minuteOfDay(value: string): number {
  if (!isValidSearchTime(value)) return 0;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * 開始<=終了は同日範囲、開始>終了は日付またぎ範囲として判定する。
 * 例: 22:00〜02:00 は 22:00〜23:59 または 00:00〜02:00。
 */
export function isMinuteWithinSearchRange(
  current: number,
  startTime: string | undefined,
  endTime: string | undefined
): boolean {
  const start = minuteOfDay(startTime ?? DEFAULT_SEARCH_START_TIME);
  const end = minuteOfDay(endTime ?? DEFAULT_SEARCH_END_TIME);
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

export function localSearchDateParts(
  date: Date,
  timeZone: string
): { weekday: number; minuteOfDay: number } {
  const local = zonedDateTimeLocalFromDate(date, timeZone);
  const year = Number(local.slice(0, 4));
  const month = Number(local.slice(5, 7));
  const day = Number(local.slice(8, 10));
  const hours = Number(local.slice(11, 13));
  const minutes = Number(local.slice(14, 16));
  return {
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minuteOfDay: hours * 60 + minutes,
  };
}

export function isLocalTimeWithinSearchRange(
  date: Date,
  timeZone: string,
  startTime: string | undefined,
  endTime: string | undefined
): boolean {
  const { minuteOfDay: current } = localSearchDateParts(date, timeZone);
  return isMinuteWithinSearchRange(current, startTime, endTime);
}
