import type { CalculationMode, CameraSettings, CameraViewCorrection } from "../types/camera";
import type { CelestialBodyId, CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { withLensCenterHeight } from "../types/points";
import type { SpotSearchDisplayCount, SpotSearchPeriod } from "../types/search";
import {
  angularDistanceFromCameraCenterDegrees,
  calculateCelestialHorizontalCoordinates,
  createCameraProjection,
  isCelestialInCameraFrame,
  type CameraProjection,
} from "../cesium/celestial";
import { computeApparentElevation } from "../apparent/apparentElevation";
import { calculateKarneyLineMetrics } from "../geodesy/karneyGeodesic";
import { isMinuteWithinSearchRange, localSearchDateParts } from "./searchTimeRange";
import {
  type RefractionWeatherContext,
} from "./refractionWeatherModel";
import {
  addLocalMonths,
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
} from "../time/zonedTime";

export type CelestialTransitSearchMode = "direction-crossing" | "in-frame";

export type CelestialTransitResult = {
  id: string;
  date: Date;
  celestialId: Exclude<CelestialBodyId, "polaris">;
  /** 画面中央（被写体方向）から天体中心までの角距離。小さいほど構図上で近い。 */
  angularDistanceDegrees: number;
};

export type CelestialTransitProgress = {
  percent: number;
  processed: number;
  total: number;
  candidateCount: number;
  currentDate?: Date;
};

export type CelestialTransitCriteria = {
  mode: CelestialTransitSearchMode;
  period: SpotSearchPeriod;
  customStartDate: string;
  customEndDate: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  displayCount: SpotSearchDisplayCount;
  includeBelowSubject: boolean;
  viewCorrection: CameraViewCorrection;
};

type SearchInput = {
  currentDate: Date;
  timeZone: string;
  tripod: GroundPoint;
  subject: GroundPoint;
  visibility: CelestialVisibility;
  calculationMode: CalculationMode;
  cameraSettings: CameraSettings;
  previewAspectRatio: number;
  criteria: CelestialTransitCriteria;
  refractionWeather?: RefractionWeatherContext;
};

const CROSSING_SAMPLE_MS = 10 * 60_000;
const MIN_FRAME_SAMPLE_MS = 60_000;
const MAX_FRAME_SAMPLE_MS = 10 * 60_000;
const MAX_APPARENT_MOTION_DEGREES_PER_MINUTE = 0.3;
const FRAME_SAMPLES_ACROSS_SHORTEST_SIDE = 4;
const BODY_ORDER: Array<Exclude<CelestialBodyId, "polaris">> = ["sun", "moon", "milkyWay"];
const DEG = Math.PI / 180;

export function celestialTransitDateRange(input: Pick<SearchInput, "currentDate" | "timeZone" | "criteria">): { start: Date; end: Date } {
  if (input.criteria.period === "custom") {
    return {
      start: dateFromZonedDateTimeLocal(`${input.criteria.customStartDate}T00:00`, input.timeZone),
      end: dateFromZonedDateTimeLocal(
        `${dateTextFromDaySerial(daySerialFromDateText(input.criteria.customEndDate) + 1)}T00:00`,
        input.timeZone
      ),
    };
  }
  // スポット検索（spotPresetSearch.ts）と同じ規約に統一する：
  // - 期間は日数固定ではなく暦月加算（1/3/6/12か月）。以前は30/90/180/365日の
  //   固定日数だったため、同じ「1か月」でも実際の終了日がスポット検索と
  //   ズレていた。
  // - 開始はその瞬間（currentDate）そのもので、現地日の00:00へは切り詰めない。
  //   以前はここだけ00:00へ切り詰めており、同じ期間指定でも開始境界が
  //   スポット検索とズレていた。
  const months = input.criteria.period === "1-month"
    ? 1
    : input.criteria.period === "3-months"
      ? 3
      : input.criteria.period === "6-months"
        ? 6
        : 12;
  return {
    start: input.currentDate,
    end: addLocalMonths(input.currentDate, months, input.timeZone),
  };
}


function signedAngularDifference(value: number, target: number): number {
  return ((value - target + 540) % 360) - 180;
}

function horizontalCoordinatesForSearch(
  body: Exclude<CelestialBodyId, "polaris">,
  date: Date,
  observer: GroundPoint,
  input: SearchInput
) {
  // 気象連動屈折の欠測フォールバック（標準大気差への切替）は
  // calculateCelestialHorizontalCoordinates内に一本化されている。
  // 検索専用の重複ロジックは持たない。
  return calculateCelestialHorizontalCoordinates(
    body,
    date,
    observer,
    input.calculationMode,
    input.refractionWeather
  );
}

function observerAtLens(input: SearchInput): GroundPoint {
  // withLensCenterHeight()に統一する（cesium/celestial.tsと同じ経路）。
  // 以前は.height（非推奨フィールド）だけを更新しており、三脚位置が既に
  // ellipsoidalHeightMeters/orthometricHeightMeters確定済みの場合、
  // createAstronomyObserver()はそちらを優先して使うため、レンズ中心高が
  // 天体計算へ一切反映されていなかった。
  return withLensCenterHeight(input.tripod, input.cameraSettings.lensCenterHeightMeters);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

type FrameProjection = CameraProjection & {
  horizontalLimit: number;
  verticalLimit: number;
  sampleIntervalMs: number;
};

function createFrameProjection(input: SearchInput): FrameProjection {
  const shared = createCameraProjection(
    input.tripod,
    input.subject,
    input.cameraSettings,
    input.previewAspectRatio,
    input.calculationMode,
    input.criteria.viewCorrection
  );
  const shortestFovDegrees = Math.min(shared.horizontalFov, shared.verticalFov);
  const estimatedTraversalMinutes = shortestFovDegrees / MAX_APPARENT_MOTION_DEGREES_PER_MINUTE;
  const sampleIntervalMs = Math.max(
    MIN_FRAME_SAMPLE_MS,
    Math.min(
      MAX_FRAME_SAMPLE_MS,
      Math.floor(estimatedTraversalMinutes * 60_000 / FRAME_SAMPLES_ACROSS_SHORTEST_SIDE)
    )
  );
  return {
    ...shared,
    horizontalLimit: Math.tan(shared.horizontalFov * DEG / 2),
    verticalLimit: Math.tan(shared.verticalFov * DEG / 2),
    sampleIntervalMs,
  };
}

function isBodyInFrame(
  body: Exclude<CelestialBodyId, "polaris">,
  date: Date,
  horizontal: { azimuthDegrees: number; altitudeDegrees: number },
  observer: GroundPoint,
  projection: FrameProjection,
  calculationMode: CalculationMode
): boolean {
  if (horizontal.altitudeDegrees <= 0.25) return false;
  return isCelestialInCameraFrame(
    body,
    date,
    observer,
    horizontal,
    projection,
    calculationMode
  );
}

function angularDistanceToFrameCenterDegrees(
  azimuthDegrees: number,
  altitudeDegrees: number,
  projection: FrameProjection
): number {
  return angularDistanceFromCameraCenterDegrees(
    { azimuthDegrees, altitudeDegrees },
    projection
  );
}


function refineFrameBoundaryTime(
  body: Exclude<CelestialBodyId, "polaris">,
  lowTime: number,
  highTime: number,
  lowInside: boolean,
  input: SearchInput,
  observer: GroundPoint,
  projection: FrameProjection,
  signal: AbortSignal
): number {
  let low = lowTime;
  let high = highTime;
  for (let index = 0; index < 24 && high - low > 1000; index += 1) {
    throwIfAborted(signal);
    const mid = Math.round((low + high) / 2);
    const horizontal = horizontalCoordinatesForSearch(body, new Date(mid), observer, input);
    const midInside = isBodyInFrame(
      body,
      new Date(mid),
      horizontal,
      observer,
      projection,
      input.calculationMode
    );
    if (midInside === lowInside) low = mid;
    else high = mid;
  }
  return lowInside ? high : low;
}

function refineClosestInFrameTime(
  body: Exclude<CelestialBodyId, "polaris">,
  lowTime: number,
  highTime: number,
  input: SearchInput,
  observer: GroundPoint,
  projection: FrameProjection,
  signal: AbortSignal
): Date {
  let low = lowTime;
  let high = highTime;
  for (let index = 0; index < 32 && high - low > 1000; index += 1) {
    throwIfAborted(signal);
    const third = (high - low) / 3;
    const left = Math.round(low + third);
    const right = Math.round(high - third);
    const leftHorizontal = horizontalCoordinatesForSearch(body, new Date(left), observer, input);
    const rightHorizontal = horizontalCoordinatesForSearch(body, new Date(right), observer, input);
    const leftDistance = angularDistanceToFrameCenterDegrees(
      leftHorizontal.azimuthDegrees,
      leftHorizontal.altitudeDegrees,
      projection
    );
    const rightDistance = angularDistanceToFrameCenterDegrees(
      rightHorizontal.azimuthDegrees,
      rightHorizontal.altitudeDegrees,
      projection
    );
    if (leftDistance <= rightDistance) high = right;
    else low = left;
  }
  return new Date(Math.round((low + high) / 2));
}

function refineCrossing(
  body: Exclude<CelestialBodyId, "polaris">,
  lowTime: number,
  highTime: number,
  targetAzimuth: number,
  input: SearchInput,
  observer: GroundPoint,
  signal: AbortSignal
): Date {
  let low = lowTime;
  let high = highTime;
  let lowError = signedAngularDifference(
    horizontalCoordinatesForSearch(body, new Date(low), observer, input).azimuthDegrees,
    targetAzimuth
  );
  for (let index = 0; index < 20 && high - low > 1000; index += 1) {
    throwIfAborted(signal);
    const mid = Math.round((low + high) / 2);
    const midError = signedAngularDifference(
      horizontalCoordinatesForSearch(body, new Date(mid), observer, input).azimuthDegrees,
      targetAzimuth
    );
    if ((lowError <= 0 && midError >= 0) || (lowError >= 0 && midError <= 0)) {
      high = mid;
    } else {
      low = mid;
      lowError = midError;
    }
  }
  return new Date(Math.round((low + high) / 2));
}

export async function searchCelestialTransitDates(
  input: SearchInput,
  signal: AbortSignal,
  onProgress: (progress: CelestialTransitProgress) => void
): Promise<CelestialTransitResult[]> {
  const bodies = BODY_ORDER.filter((body) => input.visibility[body]);
  if (bodies.length === 0) throw new Error("検索対象の天体が表示されていません");
  const { start, end } = celestialTransitDateRange(input);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("検索期間を正しく指定してください");
  }

  const results: CelestialTransitResult[] = [];
  const allowedWeekdays = input.criteria.weekdays.length > 0
    ? new Set(input.criteria.weekdays)
    : null;
  const resultIds = new Set<string>();
  const observer = observerAtLens(input);
  const subjectAltitudeDegrees = computeApparentElevation(
    observer,
    input.subject,
    input.calculationMode
  ).apparentAltitudeDegrees;
  const isCountableAltitude = (altitudeDegrees: number): boolean =>
    input.criteria.includeBelowSubject || altitudeDegrees >= subjectAltitudeDegrees;
  const targetAzimuth = input.criteria.mode === "direction-crossing"
    ? calculateKarneyLineMetrics(input.tripod, input.subject).bearingDegrees +
      input.criteria.viewCorrection.azimuthDegrees
    : null;
  // 並べ替え用の角距離は両検索モードで必要なため、被写体を中心とする
  // 投影座標系を常に作成する。画角内判定自体は in-frame のときだけ使用する。
  const resultProjection = createFrameProjection(input);
  const frameProjection = input.criteria.mode === "in-frame"
    ? resultProjection
    : null;
  const previousErrors = new Map<Exclude<CelestialBodyId, "polaris">, { time: number; error: number }>();
  const inFrameStates = new Map<Exclude<CelestialBodyId, "polaris">, {
    inside: boolean;
    intervalStart: number;
    lastInsideTime: number;
    bestTime: number;
    bestDistanceDegrees: number;
  }>();
  const lastFrameSamples = new Map<Exclude<CelestialBodyId, "polaris">, {
    time: number;
    inside: boolean;
    eligible: boolean;
  }>();
  const sampleIntervalMs = frameProjection?.sampleIntervalMs ?? CROSSING_SAMPLE_MS;
  const totalSamples = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / sampleIntervalMs) + 1);
  let processed = 0;
  let lastReportedPercent = -1;

  const reportProgress = (
    forceComplete = false,
    currentDate?: Date
  ): void => {
    const percent = forceComplete
      ? 100
      : Math.min(99, Math.max(0, Math.floor((processed / totalSamples) * 100)));
    if (percent === lastReportedPercent) return;
    lastReportedPercent = percent;
    onProgress({
      percent,
      processed,
      total: totalSamples,
      candidateCount: results.length,
      currentDate,
    });
  };

  reportProgress();

  const isDateEligible = (date: Date): boolean => {
    const time = date.getTime();
    if (time < start.getTime() || time >= end.getTime()) return false;
    const localParts = localSearchDateParts(date, input.timeZone);
    if (allowedWeekdays !== null && !allowedWeekdays.has(localParts.weekday)) {
      return false;
    }
    return isMinuteWithinSearchRange(
      localParts.minuteOfDay,
      input.criteria.startTime,
      input.criteria.endTime
    );
  };

  const refineEligibilityBoundaryTime = (
    lowTime: number,
    highTime: number,
    lowEligible: boolean
  ): number => {
    let low = lowTime;
    let high = highTime;
    for (let index = 0; index < 24 && high - low > 1000; index += 1) {
      throwIfAborted(signal);
      const mid = Math.round((low + high) / 2);
      const midEligible = isDateEligible(new Date(mid));
      if (midEligible === lowEligible) low = mid;
      else high = mid;
    }
    return lowEligible ? high : low;
  };

  const finalizeInFrameInterval = (
    body: Exclude<CelestialBodyId, "polaris">,
    state: {
      inside: boolean;
      intervalStart: number;
      lastInsideTime: number;
      bestTime: number;
      bestDistanceDegrees: number;
    },
    upperBoundTime: number
  ): void => {
    if (frameProjection === null || !state.inside) return;
    const refineLow = Math.max(state.intervalStart, state.bestTime - sampleIntervalMs);
    const refineHigh = Math.min(upperBoundTime, state.bestTime + sampleIntervalMs);
    const closestDate = refineClosestInFrameTime(
      body,
      refineLow,
      Math.max(refineLow, refineHigh),
      input,
      observer,
      frameProjection,
      signal
    );
    const closestHorizontal = horizontalCoordinatesForSearch(
      body,
      closestDate,
      observer,
      input
    );
    const id = `${body}-${closestDate.getTime()}`;
    if (
      isDateEligible(closestDate) &&
      isBodyInFrame(
        body,
        closestDate,
        closestHorizontal,
        observer,
        resultProjection,
        input.calculationMode
      ) &&
      !resultIds.has(id)
    ) {
      resultIds.add(id);
      results.push({
        id,
        date: closestDate,
        celestialId: body,
        angularDistanceDegrees: angularDistanceToFrameCenterDegrees(
          closestHorizontal.azimuthDegrees,
          closestHorizontal.altitudeDegrees,
          resultProjection
        ),
      });
    }
  };

  for (
    let time = start.getTime();
    time <= end.getTime();
    time = Math.min(time + sampleIntervalMs, end.getTime())
  ) {
    throwIfAborted(signal);
    const date = new Date(time);
    const dateEligible = isDateEligible(date);

    for (const body of bodies) {
      const horizontal = horizontalCoordinatesForSearch(body, date, observer, input);
      if (input.criteria.mode === "direction-crossing") {
        if (targetAzimuth === null) throw new Error("検索モードの初期化に失敗しました");
        const error = signedAngularDifference(horizontal.azimuthDegrees, targetAzimuth);
        const previous = previousErrors.get(body);
        if (previous && Math.abs(previous.error - error) < 180 && ((previous.error <= 0 && error >= 0) || (previous.error >= 0 && error <= 0))) {
          const crossingDate = refineCrossing(body, previous.time, time, targetAzimuth, input, observer, signal);
          const crossingHorizontal = horizontalCoordinatesForSearch(body, crossingDate, observer, input);
          const id = `${body}-${crossingDate.getTime()}`;
          if (
            isDateEligible(crossingDate) &&
            crossingHorizontal.altitudeDegrees > 0.25 &&
            isCountableAltitude(crossingHorizontal.altitudeDegrees) &&
            isBodyInFrame(
              body,
              crossingDate,
              crossingHorizontal,
              observer,
              resultProjection,
              input.calculationMode
            ) &&
            !resultIds.has(id)
          ) {
            resultIds.add(id);
            results.push({
              id,
              date: crossingDate,
              celestialId: body,
              angularDistanceDegrees: angularDistanceToFrameCenterDegrees(
                crossingHorizontal.azimuthDegrees,
                crossingHorizontal.altitudeDegrees,
                resultProjection
              ),
            });
          }
        }
        previousErrors.set(body, { time, error });
      } else {
        if (frameProjection === null) throw new Error("画角検索の初期化に失敗しました");
        const inside = isBodyInFrame(
          body,
          date,
          horizontal,
          observer,
          frameProjection,
          input.calculationMode
        ) &&
          isCountableAltitude(horizontal.altitudeDegrees);
        const distanceDegrees = angularDistanceToFrameCenterDegrees(
          horizontal.azimuthDegrees,
          horizontal.altitudeDegrees,
          frameProjection
        );
        const previous = inFrameStates.get(body);
        const lastSample = lastFrameSamples.get(body);

        if (dateEligible && inside) {
          if (!previous?.inside) {
            let intervalStart = time;
            if (lastSample) {
              const eligibleStart = lastSample.eligible
                ? lastSample.time
                : refineEligibilityBoundaryTime(lastSample.time, time, false);
              const frameStart = lastSample.inside
                ? lastSample.time
                : refineFrameBoundaryTime(
                    body,
                    lastSample.time,
                    time,
                    false,
                    input,
                    observer,
                    frameProjection,
                    signal
                  );
              intervalStart = Math.max(eligibleStart, frameStart);
            }
            inFrameStates.set(body, {
              inside: true,
              intervalStart,
              lastInsideTime: time,
              bestTime: time,
              bestDistanceDegrees: distanceDegrees,
            });
          } else {
            inFrameStates.set(body, {
              ...previous,
              lastInsideTime: time,
              bestTime: distanceDegrees < previous.bestDistanceDegrees ? time : previous.bestTime,
              bestDistanceDegrees: Math.min(distanceDegrees, previous.bestDistanceDegrees),
            });
          }
        } else if (previous?.inside) {
          let intervalEnd = previous.lastInsideTime;
          if (lastSample) {
            const eligibleEnd = lastSample.eligible && !dateEligible
              ? refineEligibilityBoundaryTime(lastSample.time, time, true)
              : time;
            const frameEnd = lastSample.inside && !inside
              ? refineFrameBoundaryTime(
                  body,
                  lastSample.time,
                  time,
                  true,
                  input,
                  observer,
                  frameProjection,
                  signal
                )
              : time;
            intervalEnd = Math.min(eligibleEnd, frameEnd);
          }
          finalizeInFrameInterval(body, previous, intervalEnd);
          inFrameStates.delete(body);
        }
        lastFrameSamples.set(body, { time, inside, eligible: dateEligible });
      }
    }

    processed += 1;
    reportProgress(false, date);
    if (processed % 100 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (time === end.getTime()) break;
  }

  if (frameProjection !== null) {
    for (const [body, state] of inFrameStates) {
      finalizeInFrameInterval(body, state, state.lastInsideTime);
    }
  }

  reportProgress(true, end);

  // UI側で「日付順」と「被写体と天体の距離順」を切り替えるため、
  // ここでは全候補を返す。表示件数の制限は並べ替え後にUI側で適用する。
  return results.sort((a, b) => a.date.getTime() - b.date.getTime());
}
