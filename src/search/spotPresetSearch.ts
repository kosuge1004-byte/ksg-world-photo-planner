import {
  Body,
  Illumination,
  MoonPhase,
} from "astronomy-engine";

import type { CalculationMode, CameraSettings } from "../types/camera";
import type {
  CelestialScreenPoint,
  CelestialOcclusion,
  HorizontalCoordinates,
} from "../types/celestial";
import type { SiteContext } from "../types/geospatial";
import type { GroundPoint } from "../types/points";
import type {
  GoogleMapsResolveResponse,
  SearchCelestialId,
  SearchResult,
  SpotPresetResult,
  SpotSearchCriteria,
  SpotSearchInterval,
  SunSearchTiming,
} from "../types/search";
import {
  dateFromZonedDateTimeLocal,
  dateTextFromDaySerial,
  daySerialFromDateText,
  zonedDateTimeLocalFromDate,
} from "../time/zonedTime";
import {
  calculateCelestialHorizontalCoordinates,
} from "../cesium/celestial";
import { calculateTripodCandidates } from "../cesium/tripodCandidates";
import {
  extractGoogleMapsCoordinates,
  extractGoogleMapsSharedUrl,
} from "./googleMapsUrl";
import { isLocalTimeWithinSearchRange } from "./searchTimeRange";
import {
  phaseMessage,
  phaseProgress,
} from "./spotSearchPhases";
import { adaptiveSearchConcurrency } from "./adaptiveConcurrency";
import {
  createSpotSearchPerformanceTracker,
  formatSearchDuration,
  type SpotSearchPerformanceMetrics,
} from "./searchPerformance";
import {
  fetchSiteContexts,
  hasMappedSiteConstraints,
  passesMappedSiteConstraints,
} from "./siteContext";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SYNODIC_MONTH_DAYS = 29.530588853;
const DEFAULT_TRIPOD_DISTANCE_MIN_METERS = 500;
const DEFAULT_TRIPOD_DISTANCE_MAX_METERS = 3_000;
const TRIPOD_DISTANCE_LIMIT_METERS = 10_000;

const BODY_LABELS: Record<SearchCelestialId, string> = {
  sun: "太陽",
  moon: "月",
  milkyWay: "天の川",
};

const INTERVAL_MILLISECONDS: Record<SpotSearchInterval, number> = {
  "1-minute": MINUTE_MS,
  "5-minutes": 5 * MINUTE_MS,
  "10-minutes": 10 * MINUTE_MS,
  "15-minutes": 15 * MINUTE_MS,
  "30-minutes": 30 * MINUTE_MS,
  "1-hour": HOUR_MS,
  "1-day": DAY_MS,
  "1-week": 7 * DAY_MS,
  "1-month": 30 * DAY_MS,
};

export type ResolvedSpotLocation = {
  latitude: number;
  longitude: number;
  label: string;
};

type SearchSample = {
  date: Date;
  horizontal: HorizontalCoordinates;
};

export type SpotPresetSearchOptions = {
  criteria: SpotSearchCriteria;
  subject: GroundPoint;
  baseDate: Date;
  timeZone: string;
  cameraSettings: CameraSettings;
  previewAspectRatio: number;
  subjectGroundHeightMeters: number;
  calculationMode: CalculationMode;
  signal?: AbortSignal;
  onProgress?: (message: string, percent: number) => void;
  /** 診断用。検索結果の判定には使用しない。 */
  onPerformance?: (metrics: SpotSearchPerformanceMetrics) => void;
  lineOfSightEvaluator: (
    tripod: GroundPoint,
    horizontal: HorizontalCoordinates,
    subjectDistanceMeters: number,
    signal?: AbortSignal
  ) => Promise<CelestialOcclusion>;
  /** サーバー実行時も同じ探索ロジックを使えるよう、地形依存処理だけを注入する。 */
  candidateCalculator?: typeof calculateTripodCandidates;
  /** ブラウザー相対URLへ依存しないサーバー側の地点情報取得処理。 */
  siteContextFetcher?: typeof fetchSiteContexts;
  /** 候補方位帯だけを先行取得するサーバー側DEMプリフェッチ。 */
  terrainPrefetcher?: (
    subject: GroundPoint,
    azimuthBand: { startDegrees: number; endDegrees: number },
    maximumDistanceMeters: number,
    signal?: AbortSignal
  ) => Promise<void>;
};

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("スポット検索を中止しました", "AbortError");
  }
}

export async function resolveSpotLocation(
  query: string,
  signal?: AbortSignal
): Promise<ResolvedSpotLocation> {
  const googleMapsUrl = extractGoogleMapsSharedUrl(query);
  if (googleMapsUrl) {
    const direct = extractGoogleMapsCoordinates(googleMapsUrl);
    if (direct) {
      return {
        ...direct,
        label: "Googleマップ共有地点",
      };
    }
    const response = await fetch("/api/resolve-google-maps", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url: googleMapsUrl }),
      signal,
    });
    const data = (await response.json()) as GoogleMapsResolveResponse;
    if (
      !response.ok ||
      typeof data.latitude !== "number" ||
      typeof data.longitude !== "number"
    ) {
      throw new Error(data.error ?? "Googleマップ共有URLを解析できませんでした");
    }
    return {
      latitude: data.latitude,
      longitude: data.longitude,
      label: "Googleマップ共有地点",
    };
  }

  const parameters = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    { headers: { Accept: "application/json" }, signal }
  );
  if (!response.ok) {
    throw new Error(`地名検索通信エラー：${response.status}`);
  }
  const result = ((await response.json()) as SearchResult[])[0];
  if (!result) throw new Error("指定したスポットが見つかりませんでした");
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("検索地点の座標が不正です");
  }
  return { latitude, longitude, label: result.display_name };
}

export async function resolveSpotTimeZone(
  location: Pick<ResolvedSpotLocation, "latitude" | "longitude">,
  fallback: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const parameters = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
    });
    const response = await fetch(`/api/timezone?${parameters}`, { signal });
    const data = (await response.json()) as { timeZone?: unknown };
    return response.ok && typeof data.timeZone === "string"
      ? data.timeZone
      : fallback;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return fallback;
  }
}

function addLocalMonths(date: Date, months: number, timeZone: string): Date {
  const local = zonedDateTimeLocalFromDate(date, timeZone);
  const [dateText, timeText] = local.split("T");
  const [year, month, day] = dateText.split("-").map(Number);
  const targetMonthStart = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = targetMonthStart.getUTCFullYear();
  const targetMonthIndex = targetMonthStart.getUTCMonth();
  const lastTargetDay = new Date(
    Date.UTC(targetYear, targetMonthIndex + 1, 0)
  ).getUTCDate();
  const shifted = new Date(
    Date.UTC(targetYear, targetMonthIndex, Math.min(day, lastTargetDay))
  );
  const shiftedDate = [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
  return dateFromZonedDateTimeLocal(`${shiftedDate}T${timeText}`, timeZone);
}

function addLocalDays(date: Date, days: number, timeZone: string): Date {
  const local = zonedDateTimeLocalFromDate(date, timeZone);
  const nextDate = dateTextFromDaySerial(
    daySerialFromDateText(local.slice(0, 10)) + days
  );
  return dateFromZonedDateTimeLocal(`${nextDate}T${local.slice(11)}`, timeZone);
}

function advanceSampleDate(
  date: Date,
  interval: SpotSearchInterval,
  intervalMilliseconds: number,
  timeZone: string
): Date {
  if (interval === "1-day") return addLocalDays(date, 1, timeZone);
  if (interval === "1-week") return addLocalDays(date, 7, timeZone);
  if (interval === "1-month") return addLocalMonths(date, 1, timeZone);
  return new Date(date.getTime() + intervalMilliseconds);
}

function searchRange(
  criteria: SpotSearchCriteria,
  baseDate: Date,
  timeZone: string
): { start: Date; end: Date } {
  if (criteria.period === "custom") {
    if (!criteria.customStartDate || !criteria.customEndDate) {
      throw new Error("検索期間の開始日と終了日を入力してください");
    }
    const start = dateFromZonedDateTimeLocal(
      `${criteria.customStartDate}T00:00`,
      timeZone
    );
    const end = dateFromZonedDateTimeLocal(
      `${criteria.customEndDate}T23:59`,
      timeZone
    );
    if (start.getTime() > end.getTime()) {
      throw new Error("検索期間の開始日が終了日より後になっています");
    }
    return { start, end };
  }
  const months = criteria.period === "1-month"
    ? 1
    : criteria.period === "3-months"
      ? 3
      : criteria.period === "6-months"
        ? 6
        : 12;
  return { start: baseDate, end: addLocalMonths(baseDate, months, timeZone) };
}

function resolvedInterval(interval: SpotSearchInterval): number {
  return INTERVAL_MILLISECONDS[interval];
}

function weekdayAtLocation(date: Date, timeZone: string): number {
  const localDateText = zonedDateTimeLocalFromDate(date, timeZone).slice(0, 10);
  // 1970-01-01は木曜(4)。UTCの通日へ変換して端末タイムゾーンに依存させない。
  return ((daySerialFromDateText(localDateText) + 4) % 7 + 7) % 7;
}

function evaluateSample(
  id: SearchCelestialId,
  date: Date,
  subject: GroundPoint,
  calculationMode: CalculationMode,
  sunSearchTiming: SunSearchTiming,
  moonAgeMinDays: number,
  moonAgeMaxDays: number
): SearchSample | null {
  if (
    id === "moon" &&
    (moonAgeMinDays > 0 || moonAgeMaxDays < SYNODIC_MONTH_DAYS)
  ) {
    const moonAgeDays = MoonPhase(date) / 360 * SYNODIC_MONTH_DAYS;
    if (moonAgeDays < moonAgeMinDays || moonAgeDays > moonAgeMaxDays) {
      return null;
    }
  }
  const horizontal = calculateCelestialHorizontalCoordinates(
    id,
    date,
    subject,
    calculationMode
  );
  const altitude = horizontal.altitudeDegrees;
  if (id === "sun") {
    if (altitude <= 0.25 || altitude >= 45) return null;
    if (sunSearchTiming === "all") {
      return { date, horizontal };
    }
    if (altitude >= 12) return null;
    const futureAltitude = calculateCelestialHorizontalCoordinates(
      "sun",
      new Date(date.getTime() + 10 * MINUTE_MS),
      subject,
      calculationMode
    ).altitudeDegrees;
    const rising = futureAltitude > altitude;
    const horizonCheckDate = new Date(
      date.getTime() + (rising ? -6 : 6) * HOUR_MS
    );
    const crossesNight = calculateCelestialHorizontalCoordinates(
      "sun",
      horizonCheckDate,
      subject,
      calculationMode
    ).altitudeDegrees <= 0.25;
    if (!crossesNight) return null;
    if (sunSearchTiming === "sunrise" && !rising) return null;
    if (sunSearchTiming === "sunset" && rising) return null;
    return { date, horizontal };
  }
  if (id === "moon") {
    if (altitude <= 0.25 || altitude >= 50) return null;
    return { date, horizontal };
  }

  if (altitude < 8 || altitude > 55) return null;
  const sunAltitude = calculateCelestialHorizontalCoordinates(
    "sun",
    date,
    subject,
    calculationMode
  ).altitudeDegrees;
  const moonAltitude = calculateCelestialHorizontalCoordinates(
    "moon",
    date,
    subject,
    calculationMode
  ).altitudeDegrees;
  const moonIllumination = Illumination(Body.Moon, date).phase_fraction;
  if (sunAltitude > -12 || (moonAltitude > 0 && moonIllumination > 0.35)) {
    return null;
  }
  return { date, horizontal };
}

function screenPointForSample(
  id: SearchCelestialId,
  sample: SearchSample
): CelestialScreenPoint {
  return {
    id,
    label: BODY_LABELS[id],
    ...sample.horizontal,
    xPercent: 50,
    yPercent: 50,
    visibleInFrame: true,
  };
}

/**
 * スポット検索では天体と被写体を必ず画面中央で完全一致させる必要はない。
 * 指定焦点距離の画角内に両方が入る撮影地点を探すため、中央解に加えて
 * 画角内の水平・垂直オフセット解も少数探索する。
 */
function screenPointsForSample(
  id: SearchCelestialId,
  sample: SearchSample,
  cameraSettings: CameraSettings,
  previewAspectRatio: number
): CelestialScreenPoint[] {
  const focalLength = Math.max(1, cameraSettings.focalLengthMm);
  const aspect = Math.max(0.25, previewAspectRatio);
  const sensorWidthMm = 36;
  const sensorHeightMm = sensorWidthMm / aspect;
  const horizontalHalfFov = Math.atan(sensorWidthMm / (2 * focalLength)) * 180 / Math.PI;
  const verticalHalfFov = Math.atan(sensorHeightMm / (2 * focalLength)) * 180 / Math.PI;
  // 円盤半径と計算誤差の余白を残し、画角端までは使わない。
  const horizontalOffset = Math.max(0, horizontalHalfFov * 0.62);
  const verticalOffset = Math.max(0, verticalHalfFov * 0.55);
  const offsets: Array<[number, number]> = [
    [0, 0],
    [-horizontalOffset, 0],
    [horizontalOffset, 0],
    [0, -verticalOffset],
    [0, verticalOffset],
  ];
  return offsets.map(([azimuthOffset, altitudeOffset], index) => ({
    ...screenPointForSample(id, sample),
    label: `${BODY_LABELS[id]}構図候補${index + 1}`,
    azimuthDegrees: (sample.horizontal.azimuthDegrees + azimuthOffset + 360) % 360,
    altitudeDegrees: sample.horizontal.altitudeDegrees + altitudeOffset,
  })).filter((point) => point.altitudeDegrees > 0.25);
}


function minimalAzimuthBand(azimuths: number[], paddingDegrees = 3): {
  startDegrees: number;
  endDegrees: number;
} | null {
  if (azimuths.length === 0) return null;
  const sorted = azimuths
    .map((value) => ((value % 360) + 360) % 360)
    .sort((a, b) => a - b);
  if (sorted.length === 1) {
    return {
      startDegrees: sorted[0] - paddingDegrees,
      endDegrees: sorted[0] + paddingDegrees,
    };
  }
  let largestGap = -1;
  let gapStartIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = index === sorted.length - 1 ? sorted[0] + 360 : sorted[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  }
  const arcStart = sorted[(gapStartIndex + 1) % sorted.length];
  const arcEnd = sorted[gapStartIndex];
  return {
    startDegrees: arcStart - paddingDegrees,
    endDegrees: arcEnd + paddingDegrees,
  };
}

function resolvedTripodDistanceRange(criteria: SpotSearchCriteria): {
  minMeters: number;
  maxMeters: number;
} {
  const rawMin = Number(criteria.tripodDistanceMinMeters);
  const rawMax = Number(criteria.tripodDistanceMaxMeters);
  const minMeters = Number.isFinite(rawMin)
    ? Math.min(TRIPOD_DISTANCE_LIMIT_METERS, Math.max(0, rawMin))
    : DEFAULT_TRIPOD_DISTANCE_MIN_METERS;
  const maxMeters = Number.isFinite(rawMax)
    ? Math.min(TRIPOD_DISTANCE_LIMIT_METERS, Math.max(0, rawMax))
    : DEFAULT_TRIPOD_DISTANCE_MAX_METERS;
  if (minMeters > maxMeters) {
    throw new Error("三脚距離の最小値は最大値以下にしてください");
  }
  return { minMeters, maxMeters };
}

export async function searchSpotPresets({
  criteria,
  subject,
  baseDate,
  timeZone,
  cameraSettings,
  previewAspectRatio,
  subjectGroundHeightMeters,
  calculationMode,
  signal,
  onProgress,
  onPerformance,
  lineOfSightEvaluator,
  candidateCalculator = calculateTripodCandidates,
  siteContextFetcher = fetchSiteContexts,
  terrainPrefetcher,
}: SpotPresetSearchOptions): Promise<SpotPresetResult[]> {
  const performanceTracker = createSpotSearchPerformanceTracker();
  // 被写体ピンの3D Tiles高が未確定・古い場合でも、検索時に取得した地表高を
  // 天体構図計算へ統一して使用する。高さ0mのまま計算される取りこぼしを防ぐ。
  const searchSubject: GroundPoint = {
    ...subject,
    height: Number.isFinite(subjectGroundHeightMeters)
      ? subjectGroundHeightMeters
      : subject.height,
  };
  performanceTracker.enterPhase(1);
  onProgress?.(phaseMessage(1), phaseProgress(1));
  const tripodDistanceRange = resolvedTripodDistanceRange(criteria);

  performanceTracker.enterPhase(2);
  onProgress?.(phaseMessage(2), phaseProgress(2));
  const range = searchRange(criteria, baseDate, timeZone);
  const duration = range.end.getTime() - range.start.getTime();
  const interval = resolvedInterval(criteria.interval);
  const sampleCount = Math.floor(duration / interval) + 1;

  performanceTracker.enterPhase(3);
  performanceTracker.increment("generatedSamples", sampleCount);
  onProgress?.(
    phaseMessage(3, `${sampleCount.toLocaleString()}時点の日時候補を生成しました`),
    phaseProgress(3, 1),
  );
  const mappedSiteConstraints = hasMappedSiteConstraints(criteria.siteConstraints);
  const results: SpotPresetResult[] = [];
  const candidateConcurrency = adaptiveSearchConcurrency("candidate", calculationMode);
  const refinementWindowSize = Math.max(12, Math.min(160, criteria.displayCount * (calculationMode === "pro" ? 4 : 3)));
  const searchProfile = calculationMode === "pro"
    ? { sampleCount: 32, refinementPasses: 3, refinementSegments: 8 }
    : { sampleCount: 16, refinementPasses: 2, refinementSegments: 6 };
  const previousDistanceByBearing = new Map<number, number>();

  type RefinedCandidate = {
    sample: SearchSample;
    candidate: NonNullable<Awaited<ReturnType<typeof candidateCalculator>>[number]>;
    siteContext?: SiteContext;
    cameraHorizontal: HorizontalCoordinates;
  };

  performanceTracker.enterPhase(4);
  onProgress?.(
    phaseMessage(4, "日時ごとの共通天文値を再利用しながら処理します"),
    phaseProgress(4),
  );

  let sampleDate = range.start;
  let checkedCount = 0;
  let coarseSamples: SearchSample[] = [];

  const refineWindow = async (samples: SearchSample[]): Promise<void> => {
    if (samples.length === 0 || results.length >= criteria.displayCount) return;
    abortIfRequested(signal);
    performanceTracker.enterPhase(10);
    onProgress?.(
      phaseMessage(10, `候補日時${samples.length}件を精密探索中（確定 ${results.length}/${criteria.displayCount}件）`),
      phaseProgress(10, checkedCount / Math.max(1, sampleCount)),
    );

    const azimuthBand = minimalAzimuthBand(
      samples.map((sample) => sample.horizontal.azimuthDegrees)
    );
    if (terrainPrefetcher && azimuthBand) {
      performanceTracker.enterPhase(7);
      onProgress?.(
        phaseMessage(7, "候補天体の必要方位帯だけ地形を先行取得しています"),
        phaseProgress(7, checkedCount / Math.max(1, sampleCount)),
      );
      try {
        performanceTracker.increment("terrainPrefetches");
        await performanceTracker.measure("terrainPrefetch", () => terrainPrefetcher(
          searchSubject,
          azimuthBand,
          tripodDistanceRange.maxMeters,
          signal
        ));
      } catch (error) {
        if (signal?.aborted ||
          (error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        // 先行取得失敗時も通常のオンデマンドDEM取得で検索を継続する。
        performanceTracker.increment("terrainPrefetchFailures");
        console.warn("必要方位帯の地形先行取得を完了できませんでした", error);
      }
    }

    const refined: Array<RefinedCandidate | null> = new Array(samples.length).fill(null);
    for (let offset = 0; offset < samples.length; offset += candidateConcurrency) {
      abortIfRequested(signal);
      const indexes = Array.from(
        { length: Math.min(candidateConcurrency, samples.length - offset) },
        (_, index) => offset + index
      );
      const batch = await Promise.all(indexes.map(async (index) => {
        const sample = samples[index];
        try {
          const bearingBucket = Math.round(sample.horizontal.azimuthDegrees / 2) * 2;
          const previousDistance = previousDistanceByBearing.get(bearingBucket);
          performanceTracker.increment("candidateAttempts");
          const candidates = await performanceTracker.measure("candidateSearch", () => candidateCalculator(
            searchSubject,
            screenPointsForSample(
              criteria.celestialId,
              sample,
              cameraSettings,
              previewAspectRatio
            ),
            cameraSettings,
            sample.date,
            calculationMode,
            undefined,
            signal,
            previewAspectRatio,
            tripodDistanceRange,
            {
              ...searchProfile,
              preferredDistanceMeters: previousDistance,
            }
          ));
          const distanceEligible = candidates.filter((candidate) =>
            candidate.distanceMeters >= tripodDistanceRange.minMeters &&
            candidate.distanceMeters <= tripodDistanceRange.maxMeters &&
            (!criteria.siteConstraints.elevationDifferenceWithin100m ||
              Math.abs(candidate.height - subjectGroundHeightMeters) <= 100)
          );
          if (distanceEligible.length === 0) return null;

          let candidate = distanceEligible[0];
          let siteContext: SiteContext | undefined;
          if (mappedSiteConstraints) {
            const contexts = await siteContextFetcher(
              distanceEligible.map((value) => ({
                latitude: value.latitude,
                longitude: value.longitude,
                height: value.height,
                label: value.label,
              })),
              signal,
              false
            );
            const acceptedIndex = contexts.findIndex((context) =>
              passesMappedSiteConstraints(context, criteria.siteConstraints)
            );
            if (acceptedIndex < 0) return null;
            candidate = distanceEligible[acceptedIndex];
            siteContext = contexts[acceptedIndex];
          }

          performanceTracker.increment("candidateAccepted");
          previousDistanceByBearing.set(bearingBucket, candidate.distanceMeters);
          const cameraHorizontal = calculateCelestialHorizontalCoordinates(
            criteria.celestialId,
            sample.date,
            {
              latitude: candidate.latitude,
              longitude: candidate.longitude,
              height: candidate.height + cameraSettings.lensCenterHeightMeters,
              label: `${BODY_LABELS[criteria.celestialId]}三脚候補レンズ中心`,
            },
            calculationMode
          );
          return { sample, candidate, siteContext, cameraHorizontal };
        } catch (error) {
          if (signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError")) {
            throw error;
          }
          performanceTracker.increment("candidateFailures");
          console.warn("スポット検索中に三脚候補を計算できませんでした", error);
          return null;
        }
      }));
      batch.forEach((value, index) => {
        refined[indexes[index]] = value;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // 三脚候補を先に絞り込んだ後、重い見通し確認だけを日時順に少数並列で行う。
    const eligible = refined.filter((value): value is RefinedCandidate => value !== null);
    for (let offset = 0; offset < eligible.length; offset += candidateConcurrency) {
      abortIfRequested(signal);
      if (results.length >= criteria.displayCount) break;
      const batch = eligible.slice(offset, offset + candidateConcurrency);
      const visibility = await Promise.all(batch.map(async (entry) => {
        try {
          performanceTracker.increment("lineOfSightChecks");
          const lineOfSight = await performanceTracker.measure("lineOfSight", () => lineOfSightEvaluator(
            {
              latitude: entry.candidate.latitude,
              longitude: entry.candidate.longitude,
              height: entry.candidate.height,
              label: `${BODY_LABELS[criteria.celestialId]}三脚候補`,
            },
            entry.cameraHorizontal,
            entry.candidate.distanceMeters,
            signal
          ));
          if (lineOfSight.verified && lineOfSight.visible) {
            performanceTracker.increment("lineOfSightVisible");
            return entry;
          }
          return null;
        } catch (error) {
          if (signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError")) {
            throw error;
          }
          performanceTracker.increment("lineOfSightFailures");
          performanceTracker.increment("lineOfSightUnverifiedAccepted");
          console.warn("スポット検索中に見通しを確認できなかったため、地形未確認候補として残します", error);
          return entry;
        }
      }));

      for (const entry of visibility) {
        if (!entry || results.length >= criteria.displayCount) continue;
        const { sample, candidate, siteContext, cameraHorizontal } = entry;
        results.push({
          id: `${criteria.celestialId}-${sample.date.getTime()}-${candidate.latitude}-${candidate.longitude}`,
          placeLabel: subject.label,
          date: sample.date,
          timeZone,
          subject: searchSubject,
          tripod: {
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            height: candidate.height,
            label: `${BODY_LABELS[criteria.celestialId]}三脚候補`,
          },
          focalLengthMm: criteria.focalLengthMm,
          celestialId: criteria.celestialId,
          celestialLabel: BODY_LABELS[criteria.celestialId],
          cameraAzimuthDegrees: cameraHorizontal.azimuthDegrees,
          cameraAltitudeDegrees: cameraHorizontal.altitudeDegrees,
          nearbyLandmarks: siteContext?.nearbyLandmarks ?? [],
          nearbyBuildings: siteContext?.nearbyBuildings ?? [],
          nearbyStructures: siteContext?.nearbyStructures ?? [],
        });
      }
      performanceTracker.enterPhase(11);
      onProgress?.(
        phaseMessage(11, `${results.length}/${criteria.displayCount}件を確定（${checkedCount}/${sampleCount}時点を確認）`),
        phaseProgress(11, checkedCount / Math.max(1, sampleCount)),
      );
    }
  };

  while (sampleDate.getTime() <= range.end.getTime()) {
    abortIfRequested(signal);
    checkedCount += 1;
    performanceTracker.increment("checkedSamples");
    const date = sampleDate;
    const weekdayAllowed = criteria.weekdays.length === 0 ||
      criteria.weekdays.includes(weekdayAtLocation(date, timeZone));
    const timeAllowed = weekdayAllowed && isLocalTimeWithinSearchRange(
      date,
      timeZone,
      criteria.startTime,
      criteria.endTime
    );
    const sample = timeAllowed
      ? evaluateSample(
          criteria.celestialId,
          date,
          searchSubject,
          calculationMode,
          criteria.sunSearchTiming,
          criteria.moonAgeMinDays,
          criteria.moonAgeMaxDays
        )
      : null;
    if (sample) {
      performanceTracker.increment("celestialMatches");
      coarseSamples.push(sample);
    }

    const shouldRefine = coarseSamples.length >= refinementWindowSize ||
      checkedCount >= sampleCount;
    if (shouldRefine) {
      const window = coarseSamples;
      coarseSamples = [];
      await refineWindow(window);
      if (results.length >= criteria.displayCount) break;
    }

    if (checkedCount % 50 === 0) {
      const scanFraction = checkedCount / Math.max(1, sampleCount);
      const scanPhase = scanFraction < 0.5 ? 5 : 6;
      performanceTracker.enterPhase(scanPhase);
      onProgress?.(
        phaseMessage(
          scanPhase,
          `${checkedCount}/${sampleCount}時点を確認（候補 ${coarseSamples.length}件、確定 ${results.length}/${criteria.displayCount}件）`,
        ),
        phaseProgress(scanPhase, scanFraction < 0.5 ? scanFraction * 2 : (scanFraction - 0.5) * 2),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const nextDate = advanceSampleDate(sampleDate, criteria.interval, interval, timeZone);
    if (nextDate.getTime() <= sampleDate.getTime()) break;
    sampleDate = nextDate;
  }

  if (coarseSamples.length > 0 && results.length < criteria.displayCount) {
    await refineWindow(coarseSamples);
  }

  // 通行条件がない検索では、採用結果だけを最後にまとめて照合してOverpass待ちを最小化する。
  if (results.length > 0) {
    performanceTracker.enterPhase(11);
    onProgress?.(
      phaseMessage(11, "候補地点の建物・ランドマーク情報を一括取得しています"),
      phaseProgress(11, 0.85),
    );
    try {
      performanceTracker.increment("siteContextRequests");
      const siteContexts = await performanceTracker.measure("siteContext", () => siteContextFetcher(
        results.map((result) => result.tripod),
        signal,
        true
      ));
      results.forEach((result, index) => {
        const siteContext = siteContexts[index];
        if (!siteContext) return;
        result.nearbyLandmarks = siteContext.nearbyLandmarks;
        result.nearbyBuildings = siteContext.nearbyBuildings;
        result.nearbyStructures = siteContext.nearbyStructures;
      });
    } catch (error) {
      if (signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      console.warn("建物・ランドマーク情報を取得できませんでした", error);
    }
  }

  // 標高・地形取得の障害を「候補0件」と誤表示しない。
  // 三脚候補計算が一度も成功せず、計算例外だけが発生した場合は検索障害として明示する。
  const interimMetrics = performanceTracker.snapshot(results.length);
  if (results.length === 0 &&
      interimMetrics.counters.candidateAccepted === 0 &&
      interimMetrics.counters.candidateFailures > 0) {
    onPerformance?.(interimMetrics);
    throw new Error(
      `標高・地形データの取得または三脚候補計算に失敗しました（失敗 ${interimMetrics.counters.candidateFailures}件）。候補0件ではなく検索処理エラーです。`
    );
  }

  performanceTracker.enterPhase(12);
  onProgress?.(
    phaseMessage(12, `${results.length}件の候補を日時順に整理しています`),
    phaseProgress(12, 0.5),
  );
  const sortedResults = results.sort((a, b) => a.date.getTime() - b.date.getTime());
  const metrics = performanceTracker.complete(sortedResults.length);
  onPerformance?.(metrics);
  console.info("[spot-search-performance]", metrics);
  onProgress?.(
    phaseMessage(12, `検索結果を確定しました（所要時間 ${formatSearchDuration(metrics.totalMilliseconds)}）`),
    100,
  );
  return sortedResults;
}
