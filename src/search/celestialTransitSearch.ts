import type { CalculationMode, CameraSettings } from "../types/camera";
import type { CelestialBodyId, CelestialVisibility } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import type { SpotSearchDisplayCount, SpotSearchPeriod } from "../types/search";
import { calculateCelestialHorizontalCoordinates } from "../cesium/celestial";
import { sensorDimensionsMm } from "../cesium/camera";
import { calculateLineMetrics } from "../cesium/geometry";
import { isLocalTimeWithinSearchRange } from "./searchTimeRange";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";

export type CelestialTransitSearchMode = "direction-crossing" | "in-frame";

export type CelestialTransitResult = {
  id: string;
  date: Date;
  celestialId: Exclude<CelestialBodyId, "polaris">;
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
};

const CROSSING_SAMPLE_MS = 10 * 60_000;
const MIN_FRAME_SAMPLE_MS = 60_000;
const MAX_FRAME_SAMPLE_MS = 10 * 60_000;
const MAX_APPARENT_MOTION_DEGREES_PER_MINUTE = 0.3;
const FRAME_SAMPLES_ACROSS_SHORTEST_SIDE = 4;
const BODY_ORDER: Array<Exclude<CelestialBodyId, "polaris">> = ["sun", "moon", "milkyWay"];
const DEG = Math.PI / 180;

function dateRange(input: SearchInput): { start: Date; end: Date } {
  const currentLocalDate = zonedDateTimeLocalFromDate(input.currentDate, input.timeZone).slice(0, 10);
  let startText = currentLocalDate;
  let endExclusiveText: string;
  if (input.criteria.period === "custom") {
    startText = input.criteria.customStartDate;
    endExclusiveText = dateTextFromDaySerial(daySerialFromDateText(input.criteria.customEndDate) + 1);
  } else {
    const days = input.criteria.period === "1-month" ? 30 : input.criteria.period === "3-months" ? 90 : input.criteria.period === "6-months" ? 180 : 365;
    endExclusiveText = dateTextFromDaySerial(daySerialFromDateText(startText) + days);
  }
  return {
    start: dateFromZonedDateTimeLocal(`${startText}T00:00`, input.timeZone),
    end: dateFromZonedDateTimeLocal(`${endExclusiveText}T00:00`, input.timeZone),
  };
}

function localWeekday(date: Date, timeZone: string): number {
  const dateText = zonedDateTimeLocalFromDate(date, timeZone).slice(0, 10);
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function signedAngularDifference(value: number, target: number): number {
  return ((value - target + 540) % 360) - 180;
}

function horizontalDirection(azimuthDegrees: number, altitudeDegrees: number) {
  const az = azimuthDegrees * DEG;
  const alt = altitudeDegrees * DEG;
  const horizontal = Math.cos(alt);
  return { east: horizontal * Math.sin(az), north: horizontal * Math.cos(az), up: Math.sin(alt) };
}

function dot(a: { east: number; north: number; up: number }, b: { east: number; north: number; up: number }) {
  return a.east * b.east + a.north * b.north + a.up * b.up;
}

function observerAtLens(input: SearchInput): GroundPoint {
  return {
    ...input.tripod,
    height: input.tripod.height + input.cameraSettings.lensCenterHeightMeters,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

type FrameProjection = {
  forward: { east: number; north: number; up: number };
  right: { east: number; north: number; up: number };
  up: { east: number; north: number; up: number };
  horizontalLimit: number;
  verticalLimit: number;
  sampleIntervalMs: number;
};

function createFrameProjection(input: SearchInput): FrameProjection {
  const line = calculateLineMetrics(input.tripod, input.subject);
  const cameraAzimuth = line.bearingDegrees;
  const cameraAltitude = Math.atan2(
    input.subject.height - (input.tripod.height + input.cameraSettings.lensCenterHeightMeters),
    Math.max(line.distanceMeters, 0.001)
  ) / DEG;
  const sensor = sensorDimensionsMm(input.previewAspectRatio);
  const horizontalFov = 2 * Math.atan(sensor.width / (2 * input.cameraSettings.focalLengthMm));
  const verticalFov = 2 * Math.atan(sensor.height / (2 * input.cameraSettings.focalLengthMm));
  const az = cameraAzimuth * DEG;
  const alt = cameraAltitude * DEG;
  const shortestFovDegrees = Math.min(horizontalFov, verticalFov) / DEG;
  const estimatedTraversalMinutes = shortestFovDegrees / MAX_APPARENT_MOTION_DEGREES_PER_MINUTE;
  const sampleIntervalMs = Math.max(
    MIN_FRAME_SAMPLE_MS,
    Math.min(
      MAX_FRAME_SAMPLE_MS,
      Math.floor(estimatedTraversalMinutes * 60_000 / FRAME_SAMPLES_ACROSS_SHORTEST_SIDE)
    )
  );
  return {
    forward: horizontalDirection(cameraAzimuth, cameraAltitude),
    right: { east: Math.cos(az), north: -Math.sin(az), up: 0 },
    up: {
      east: -Math.sin(az) * Math.sin(alt),
      north: -Math.cos(az) * Math.sin(alt),
      up: Math.cos(alt),
    },
    horizontalLimit: Math.tan(horizontalFov / 2),
    verticalLimit: Math.tan(verticalFov / 2),
    sampleIntervalMs,
  };
}

function isBodyInFrame(
  azimuthDegrees: number,
  altitudeDegrees: number,
  projection: FrameProjection
): boolean {
  if (altitudeDegrees <= 0.25) return false;
  const direction = horizontalDirection(azimuthDegrees, altitudeDegrees);
  const front = dot(direction, projection.forward);
  if (front <= 1e-8) return false;
  const x = dot(direction, projection.right) / front;
  const y = dot(direction, projection.up) / front;
  return Math.abs(x) <= projection.horizontalLimit && Math.abs(y) <= projection.verticalLimit;
}

function angularDistanceToFrameCenterDegrees(
  azimuthDegrees: number,
  altitudeDegrees: number,
  projection: FrameProjection
): number {
  const direction = horizontalDirection(azimuthDegrees, altitudeDegrees);
  const cosine = Math.max(-1, Math.min(1, dot(direction, projection.forward)));
  return Math.acos(cosine) / DEG;
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
    const leftHorizontal = calculateCelestialHorizontalCoordinates(
      body,
      new Date(left),
      observer,
      input.calculationMode
    );
    const rightHorizontal = calculateCelestialHorizontalCoordinates(
      body,
      new Date(right),
      observer,
      input.calculationMode
    );
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
    calculateCelestialHorizontalCoordinates(body, new Date(low), observer, input.calculationMode).azimuthDegrees,
    targetAzimuth
  );
  for (let index = 0; index < 20 && high - low > 1000; index += 1) {
    throwIfAborted(signal);
    const mid = Math.round((low + high) / 2);
    const midError = signedAngularDifference(
      calculateCelestialHorizontalCoordinates(body, new Date(mid), observer, input.calculationMode).azimuthDegrees,
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
  onProgress: (message: string) => void
): Promise<CelestialTransitResult[]> {
  const bodies = BODY_ORDER.filter((body) => input.visibility[body]);
  if (bodies.length === 0) throw new Error("検索対象の天体が表示されていません");
  const { start, end } = dateRange(input);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("検索期間を正しく指定してください");
  }

  const results: CelestialTransitResult[] = [];
  const resultIds = new Set<string>();
  const observer = observerAtLens(input);
  const targetAzimuth = input.criteria.mode === "direction-crossing"
    ? calculateLineMetrics(input.tripod, input.subject).bearingDegrees
    : null;
  const frameProjection = input.criteria.mode === "in-frame"
    ? createFrameProjection(input)
    : null;
  const previousErrors = new Map<Exclude<CelestialBodyId, "polaris">, { time: number; error: number }>();
  const inFrameStates = new Map<Exclude<CelestialBodyId, "polaris">, {
    inside: boolean;
    intervalStart: number;
    lastInsideTime: number;
    bestTime: number;
    bestDistanceDegrees: number;
  }>();
  const sampleIntervalMs = frameProjection?.sampleIntervalMs ?? CROSSING_SAMPLE_MS;
  const totalSamples = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / sampleIntervalMs));
  let processed = 0;

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
    const id = `${body}-${closestDate.getTime()}`;
    if (!resultIds.has(id)) {
      resultIds.add(id);
      results.push({ id, date: closestDate, celestialId: body });
    }
  };

  for (let time = start.getTime(); time < end.getTime(); time += sampleIntervalMs) {
    throwIfAborted(signal);
    const date = new Date(time);
    const weekday = localWeekday(date, input.timeZone);
    if (input.criteria.weekdays.length > 0 && !input.criteria.weekdays.includes(weekday)) {
      previousErrors.clear();
      for (const [body, state] of inFrameStates) {
        finalizeInFrameInterval(body, state, state.lastInsideTime);
      }
      inFrameStates.clear();
      if (results.length >= input.criteria.displayCount) {
        return results.sort((a, b) => a.date.getTime() - b.date.getTime());
      }
      processed += 1;
      continue;
    }
    if (!isLocalTimeWithinSearchRange(date, input.timeZone, input.criteria.startTime, input.criteria.endTime)) {
      previousErrors.clear();
      for (const [body, state] of inFrameStates) {
        finalizeInFrameInterval(body, state, state.lastInsideTime);
      }
      inFrameStates.clear();
      if (results.length >= input.criteria.displayCount) {
        return results.sort((a, b) => a.date.getTime() - b.date.getTime());
      }
      processed += 1;
      continue;
    }

    for (const body of bodies) {
      const horizontal = calculateCelestialHorizontalCoordinates(body, date, observer, input.calculationMode);
      if (input.criteria.mode === "direction-crossing") {
        if (targetAzimuth === null) throw new Error("検索モードの初期化に失敗しました");
        const error = signedAngularDifference(horizontal.azimuthDegrees, targetAzimuth);
        const previous = previousErrors.get(body);
        if (previous && Math.abs(previous.error - error) < 180 && ((previous.error <= 0 && error >= 0) || (previous.error >= 0 && error <= 0))) {
          const crossingDate = refineCrossing(body, previous.time, time, targetAzimuth, input, observer, signal);
          const crossingHorizontal = calculateCelestialHorizontalCoordinates(body, crossingDate, observer, input.calculationMode);
          const id = `${body}-${crossingDate.getTime()}`;
          if (crossingHorizontal.altitudeDegrees > 0.25 && !resultIds.has(id)) {
            resultIds.add(id);
            results.push({ id, date: crossingDate, celestialId: body });
          }
        }
        previousErrors.set(body, { time, error });
      } else {
        if (frameProjection === null) throw new Error("画角検索の初期化に失敗しました");
        const inside = isBodyInFrame(horizontal.azimuthDegrees, horizontal.altitudeDegrees, frameProjection);
        const distanceDegrees = angularDistanceToFrameCenterDegrees(
          horizontal.azimuthDegrees,
          horizontal.altitudeDegrees,
          frameProjection
        );
        const previous = inFrameStates.get(body);

        if (inside) {
          if (!previous || !previous.inside) {
            inFrameStates.set(body, {
              inside: true,
              intervalStart: time,
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
          finalizeInFrameInterval(body, previous, time);
          inFrameStates.delete(body);
        }
      }
      if (results.length >= input.criteria.displayCount) {
        return results.sort((a, b) => a.date.getTime() - b.date.getTime());
      }
    }

    processed += 1;
    if (processed % 100 === 0) {
      const label = input.criteria.mode === "direction-crossing" ? "被写体方向を横切る時刻" : "画角内で被写体に最も近い時刻";
      onProgress(`${label}を検索中… ${Math.min(99, Math.round(processed / totalSamples * 100))}%`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  if (frameProjection !== null) {
    for (const [body, state] of inFrameStates) {
      finalizeInFrameInterval(body, state, state.lastInsideTime);
    }
  }

  return results
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, input.criteria.displayCount);
}
