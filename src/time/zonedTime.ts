export type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(value: string): boolean {
  try {
    formatter(value).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const values = new Map(
    formatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.get("year") ?? 1970,
    month: values.get("month") ?? 1,
    day: values.get("day") ?? 1,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

export function zonedDateTimeLocalFromDate(
  date: Date,
  timeZone: string
): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(
    parts.hour
  )}:${pad2(parts.minute)}`;
}

export function parseDateTimeLocalParts(value: string): ZonedDateParts | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  const valid =
    parts.month >= 1 &&
    parts.month <= 12 &&
    parts.day >= 1 &&
    parts.day <= 31 &&
    parts.hour >= 0 &&
    parts.hour <= 23 &&
    parts.minute >= 0 &&
    parts.minute <= 59 &&
    parts.second >= 0 &&
    parts.second <= 59;
  return valid ? parts : null;
}

export function dateFromZonedDateTimeLocal(
  value: string,
  timeZone: string
): Date {
  const target = parseDateTimeLocalParts(value);
  if (!target) return new Date(Number.NaN);
  const targetAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );
  let timestamp = targetAsUtc;

  // Intlが返す現地時刻との差を反復し、IANAタイムゾーンのDSTを含めてUTCへ変換する。
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedDateParts(new Date(timestamp), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = targetAsUtc - actualAsUtc;
    timestamp += correction;
    if (correction === 0) break;
  }
  return new Date(timestamp);
}

export function daySerialFromDateText(dateText: string): number {
  const [year, month, day] = dateText.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function dateTextFromDaySerial(serial: number): string {
  const date = new Date(serial * 86_400_000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
}

export function formatZonedTime(date: Date | null, timeZone: string): string {
  if (!date) return "--:--";
  const parts = zonedDateParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}
