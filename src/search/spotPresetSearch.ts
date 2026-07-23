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
  TripodCandidate,
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
  auto: 0,
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
  score: number;
};

type CandidateRecord = {
  sample: SearchSample;
  candidate: TripodCandidate;
  siteContext?: SiteContext;
};

type VisibleCandidateRecord = CandidateRecord & {
  cameraHorizontal: HorizontalCoordinates;
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
  onProgress?: (message: string) => void;
  lineOfSightEvaluator: (
    tripod: GroundPoint,
    horizontal: HorizontalCoordinates,
    signal?: AbortSignal
  ) => Promise<CelestialOcclusion>;
  /** サーバー実行時も同じ探索ロジックを使えるよう、地形依存処理だけを注入する。 */
  candidateCalculator?: typeof calculateTripodCandidates;
  /** ブラウザー相対URLへ依存しないサーバー側の地点情報取得処理。 */
  siteContextFetcher?: typeof fetchSiteContexts;
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

function resolvedInterval(
  interval: SpotSearchInterval,
  durationMilliseconds: number
): number {
  if (interval !== "auto") return INTERVAL_MILLISECONDS[interval];
  if (durationMilliseconds <= 35 * DAY_MS) return 30 * MINUTE_MS;
  if (durationMilliseconds <= 100 * DAY_MS) return HOUR_MS;
  if (durationMilliseconds <= 200 * DAY_MS) return 2 * HOUR_MS;
  return 4 * HOUR_MS;
}

function weekdayAtLocation(date: Date, timeZone: string): number {
  const localDateText = zonedDateTimeLocalFromDate(date, timeZone).slice(0, 10);
  // 1970-01-01は木曜(4)。UTCの通日へ変換して端末タイムゾーンに依存させない。
  return ((daySerialFromDateText(localDateText) + 4) % 7 + 7) % 7;
}

function sampleScore(
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
      return { date, horizontal, score: Math.abs(altitude - 8) };
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
    return { date, horizontal, score: Math.abs(altitude - 1) };
  }
  if (id === "moon") {
    if (altitude <= 0.25 || altitude >= 50) return null;
    return {
      date,
      horizontal,
      // 月の明るさを順位へ加点すると満月付近だけで上位が埋まるため、高度だけで評価する。
      score: Math.abs(altitude - 12),
    };
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
  return {
    date,
    horizontal,
    score: Math.abs(altitude - 22) + moonIllumination,
  };
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
  lineOfSightEvaluator,
  candidateCalculator = calculateTripodCandidates,
  siteContextFetcher = fetchSiteContexts,
}: SpotPresetSearchOptions): Promise<SpotPresetResult[]> {
  const tripodDistanceRange = resolvedTripodDistanceRange(criteria);
  const range = searchRange(criteria, baseDate, timeZone);
  const duration = range.end.getTime() - range.start.getTime();
  const interval = resolvedInterval(criteria.interval, duration);
  const sampleCount = Math.floor(duration / interval) + 1;
  const poolLimit = Math.max(80, Math.min(800, criteria.displayCount * 8));
  let pool: SearchSample[] = [];

  onProgress?.(`${sampleCount.toLocaleString()}時点の天体位置を検索中…`);
  let sampleDate = range.start;
  for (let index = 0; sampleDate.getTime() <= range.end.getTime(); index += 1) {
    abortIfRequested(signal);
    const date = sampleDate;
    const weekdayAllowed = criteria.weekdays.length === 0 ||
      criteria.weekdays.includes(weekdayAtLocation(date, timeZone));
    const sample = weekdayAllowed
      ? sampleScore(
          criteria.celestialId,
          date,
          subject,
          calculationMode,
          criteria.sunSearchTiming,
          criteria.moonAgeMinDays,
          criteria.moonAgeMaxDays
        )
      : null;
    if (sample) pool.push(sample);
    if (pool.length >= poolLimit * 2) {
      pool = pool.sort((a, b) => a.score - b.score).slice(0, poolLimit);
    }
    if (index > 0 && index % 400 === 0) {
      onProgress?.(
        `天体位置を検索中… ${Math.min(100, Math.round(index / sampleCount * 100))}%`
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const nextDate = advanceSampleDate(
      sampleDate,
      criteria.interval,
      interval,
      timeZone
    );
    if (nextDate.getTime() <= sampleDate.getTime()) break;
    sampleDate = nextDate;
  }
  pool = pool.sort((a, b) => a.score - b.score).slice(0, poolLimit);

  const minimumSpacing = Math.max(interval, criteria.celestialId === "milkyWay"
    ? 6 * HOUR_MS
    : 3 * HOUR_MS);
  const distinct: SearchSample[] = [];
  for (const sample of pool) {
    if (distinct.every(
      (existing) => Math.abs(existing.date.getTime() - sample.date.getTime()) >= minimumSpacing
    )) {
      distinct.push(sample);
    }
  }

  const attempts = distinct.slice(
    0,
    Math.min(300, Math.max(60, criteria.displayCount * 4))
  );
  const mappedSiteConstraints = hasMappedSiteConstraints(criteria.siteConstraints);
  const results: SpotPresetResult[] = [];
  for (let offset = 0; offset < attempts.length;) {
    abortIfRequested(signal);
    const remainingResultCount = criteria.displayCount - results.length;
    const failedAttemptCount = Math.max(0, offset - results.length);
    const rejectionBackoffBatchSize = failedAttemptCount === 0
      ? 1
      : failedAttemptCount < 3
        ? 2
        : 4;
    // 少数件は最初の成功まで最小限だけ計算し、不採用が続く場合は並列度を戻して待ち時間を抑える。
    const batchSize = Math.min(
      4,
      Math.max(1, remainingResultCount, rejectionBackoffBatchSize)
    );
    const batch = attempts.slice(offset, offset + batchSize);
    const processedAttemptCount = offset + batch.length;
    onProgress?.(
      `地表上の三脚位置を計算中… ${processedAttemptCount}/${attempts.length}`
    );
    const batchCandidates = await Promise.all(
      batch.map(async (sample) => {
        try {
          const candidates = await candidateCalculator(
            subject,
            [screenPointForSample(criteria.celestialId, sample)],
            cameraSettings,
            sample.date,
            calculationMode,
            undefined,
            signal,
            previewAspectRatio,
            tripodDistanceRange
          );
          return { sample, candidate: candidates[0] ?? null };
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            throw error;
          }
          console.warn("スポット検索中に三脚候補を計算できませんでした", error);
          return { sample, candidate: null };
        }
      })
    );

    // 高さだけで除外できる候補には、外部の道路・建物照会や遮蔽計算を実行しない。
    let candidateRecords: CandidateRecord[] = batchCandidates.flatMap(
      ({ sample, candidate }) => candidate ? [{ sample, candidate }] : []
    ).filter(({ candidate }) =>
      candidate.distanceMeters >= tripodDistanceRange.minMeters &&
      candidate.distanceMeters <= tripodDistanceRange.maxMeters
    ).filter(({ candidate }) => !(
      criteria.siteConstraints.elevationDifferenceWithin100m &&
      Math.abs(candidate.height - subjectGroundHeightMeters) > 100
    ));

    // 通行条件を指定した場合だけ先に地理情報を取得し、不適合候補の重い遮蔽検証を省く。
    if (mappedSiteConstraints && candidateRecords.length > 0) {
      onProgress?.(
        `道路・通行条件を照合中… ${processedAttemptCount}/${attempts.length}`
      );
      try {
        const siteContexts = await siteContextFetcher(
          candidateRecords.map(({ candidate }) => ({
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            height: candidate.height,
            label: candidate.label,
          })),
          signal,
          false
        );
        candidateRecords = candidateRecords.flatMap((record, index) => {
          const siteContext = siteContexts[index];
          return siteContext && passesMappedSiteConstraints(
            siteContext,
            criteria.siteConstraints
          )
            ? [{ ...record, siteContext }]
            : [];
        });
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw error;
        }
        throw new Error(
          `道路・通行制限を検証できないため候補を確定できません：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    onProgress?.(
      `稜線・建物による天体の目視可否を並列検証中… ${processedAttemptCount}/${attempts.length}`
    );
    const checkedRecords = await Promise.all(candidateRecords.map(
      async (record): Promise<VisibleCandidateRecord | null> => {
        const { sample, candidate } = record;
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
        const lineOfSight = await lineOfSightEvaluator(
          {
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            height: candidate.height,
            label: `${BODY_LABELS[criteria.celestialId]}三脚候補`,
          },
          cameraHorizontal,
          signal
        );
        // 高精度検索では、遮蔽未検証または中心視線が遮られる候補を結果へ混ぜない。
        return lineOfSight.verified && lineOfSight.visible
          ? { ...record, cameraHorizontal }
          : null;
      }
    ));
    const visibleRecords = checkedRecords.filter(
      (record): record is VisibleCandidateRecord => record !== null
    );

    for (const {
      sample,
      candidate,
      cameraHorizontal,
      siteContext,
    } of visibleRecords) {
      results.push({
        id: `${criteria.celestialId}-${sample.date.getTime()}-${candidate.latitude}-${candidate.longitude}`,
        placeLabel: subject.label,
        date: sample.date,
        timeZone,
        subject,
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
        alignmentErrorDegrees: candidate.alignmentErrorDegrees,
        nearbyLandmarks: siteContext?.nearbyLandmarks ?? [],
        nearbyBuildings: siteContext?.nearbyBuildings ?? [],
        nearbyStructures: siteContext?.nearbyStructures ?? [],
      });
      if (results.length >= criteria.displayCount) break;
    }
    if (results.length >= criteria.displayCount) break;
    offset = processedAttemptCount;
  }

  // 通行条件がない検索では、採用結果だけを最後にまとめて照合してOverpass待ちを最小化する。
  if (results.length > 0) {
    onProgress?.("候補地点の建物・ランドマーク情報を一括取得中…");
    try {
      const siteContexts = await siteContextFetcher(
        results.map((result) => result.tripod),
        signal,
        true
      );
      results.forEach((result, index) => {
        const siteContext = siteContexts[index];
        if (!siteContext) return;
        result.nearbyLandmarks = siteContext.nearbyLandmarks;
        result.nearbyBuildings = siteContext.nearbyBuildings;
        result.nearbyStructures = siteContext.nearbyStructures;
      });
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      console.warn("建物・ランドマーク情報を取得できませんでした", error);
    }
  }

  return results.sort((a, b) => a.date.getTime() - b.date.getTime());
}
