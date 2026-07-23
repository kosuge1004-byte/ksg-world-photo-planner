import type { CalculationMode } from "../types/camera";
import type { CelestialBodyId, CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { SpotSearchDisplayCount, SpotSearchPeriod } from "../types/search";
import { calculateCelestialHorizontalCoordinates } from "../cesium/celestial";
import { calculateLineMetrics } from "../cesium/geometry";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";

export type CelestialTransitResult = {
  id: string;
  date: Date;
  celestialId: Exclude<CelestialBodyId, "polaris">;
};

export type CelestialTransitCriteria = {
  period: SpotSearchPeriod;
  customStartDate: string;
  customEndDate: string;
  weekdays: number[];
  displayCount: SpotSearchDisplayCount;
};

type SearchInput = {
  currentDate: Date;
  timeZone: string;
  tripod: GroundPoint;
  subject: GroundPoint;
  visibility: CelestialVisibility;
  calculationMode: CalculationMode;
  criteria: CelestialTransitCriteria;
};

const SAMPLE_MS = 10 * 60_000;
const BODY_ORDER: Array<Exclude<CelestialBodyId, "polaris">> = ["sun", "moon", "milkyWay"];

function signedAngularDifference(degrees: number, targetDegrees: number): number {
  return ((degrees - targetDegrees + 540) % 360) - 180;
}

function dateRange(input: SearchInput): { start: Date; end: Date } {
  const currentLocalDate = zonedDateTimeLocalFromDate(input.currentDate, input.timeZone).slice(0, 10);
  let startText = currentLocalDate;
  let endExclusiveText: string;
  if (input.criteria.period === "custom") {
    startText = input.criteria.customStartDate;
    endExclusiveText = dateTextFromDaySerial(
      daySerialFromDateText(input.criteria.customEndDate) + 1
    );
  } else {
    const days = input.criteria.period === "1-month"
      ? 30
      : input.criteria.period === "3-months"
        ? 90
        : input.criteria.period === "6-months"
          ? 180
          : 365;
    endExclusiveText = dateTextFromDaySerial(daySerialFromDateText(startText) + days);
  }
  const start = dateFromZonedDateTimeLocal(`${startText}T00:00`, input.timeZone);
  const endExclusive = dateFromZonedDateTimeLocal(
    `${endExclusiveText}T00:00`,
    input.timeZone
  );
  return { start, end: endExclusive };
}

function localWeekday(date: Date, timeZone: string): number {
  const dateText = zonedDateTimeLocalFromDate(date, timeZone).slice(0, 10);
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function refineCrossing(
  body: Exclude<CelestialBodyId, "polaris">,
  leftDate: Date,
  rightDate: Date,
  targetAzimuth: number,
  tripod: GroundPoint,
  calculationMode: CalculationMode
): Date {
  let left = leftDate.getTime();
  let right = rightDate.getTime();
  let leftError = signedAngularDifference(
    calculateCelestialHorizontalCoordinates(body, new Date(left), tripod, calculationMode).azimuthDegrees,
    targetAzimuth
  );
  for (let index = 0; index < 24; index += 1) {
    const middle = Math.round((left + right) / 2);
    const middleError = signedAngularDifference(
      calculateCelestialHorizontalCoordinates(body, new Date(middle), tripod, calculationMode).azimuthDegrees,
      targetAzimuth
    );
    if (Math.abs(middleError) < 0.0001) return new Date(middle);
    if (Math.sign(leftError) === Math.sign(middleError)) {
      left = middle;
      leftError = middleError;
    } else {
      right = middle;
    }
  }
  return new Date(Math.round((left + right) / 2));
}

export async function searchCelestialTransitDates(
  input: SearchInput,
  signal: AbortSignal,
  onProgress: (message: string) => void
): Promise<CelestialTransitResult[]> {
  const bodies = BODY_ORDER.filter((body) => input.visibility[body]);
  if (bodies.length === 0) throw new Error("検索対象の天体が表示されていません");
  const { start, end } = dateRange(input);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("検索期間を正しく指定してください");
  }

  const targetAzimuth = calculateLineMetrics(input.tripod, input.subject).bearingDegrees;
  const results: CelestialTransitResult[] = [];
  const totalSamples = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / SAMPLE_MS));
  let processed = 0;

  for (const body of bodies) {
    let previousDate = new Date(start);
    let previousError = signedAngularDifference(
      calculateCelestialHorizontalCoordinates(body, previousDate, input.tripod, input.calculationMode).azimuthDegrees,
      targetAzimuth
    );
    for (let time = start.getTime() + SAMPLE_MS; time <= end.getTime(); time += SAMPLE_MS) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const currentDate = new Date(Math.min(time, end.getTime()));
      const currentError = signedAngularDifference(
        calculateCelestialHorizontalCoordinates(body, currentDate, input.tripod, input.calculationMode).azimuthDegrees,
        targetAzimuth
      );
      const isContinuous = Math.abs(currentError - previousError) < 180;
      if (isContinuous && (previousError === 0 || currentError === 0 || Math.sign(previousError) !== Math.sign(currentError))) {
        const crossing = refineCrossing(
          body,
          previousDate,
          currentDate,
          targetAzimuth,
          input.tripod,
          input.calculationMode
        );
        const weekday = localWeekday(crossing, input.timeZone);
        const weekdayAllowed = input.criteria.weekdays.length === 0 || input.criteria.weekdays.includes(weekday);
        const duplicate = results.some((result) =>
          result.celestialId === body && Math.abs(result.date.getTime() - crossing.getTime()) < 5 * 60_000
        );
        if (weekdayAllowed && !duplicate) {
          results.push({ id: `${body}-${crossing.getTime()}`, date: crossing, celestialId: body });
        }
      }
      previousDate = currentDate;
      previousError = currentError;
      processed += 1;
      if (processed % 500 === 0) {
        onProgress(`天体通過日時を検索中… ${Math.min(99, Math.round(processed / (totalSamples * bodies.length) * 100))}%`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  }

  return results
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .slice(0, input.criteria.displayCount);
}
