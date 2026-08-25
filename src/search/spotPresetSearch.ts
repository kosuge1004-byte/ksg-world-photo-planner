import { createAbortError, isAbortError } from "../utils/runtimeErrors";
import {
  Body,
  Illumination,
  MoonPhase,
} from "astronomy-engine";
import { diagnosticFetch } from "../network/networkDiagnostics";
import { requestTimeZone } from "../network/timeZoneRequest";

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
  addLocalMonths,
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
  canResolveGoogleMapsNatively,
  resolveGoogleMapsSharedUrlNatively,
} from "./nativeGoogleMapsResolver";
import { isMinuteWithinSearchRange, localSearchDateParts } from "./searchTimeRange";
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

const LOCATION_CACHE_STORAGE_KEY = "astrosight-place-search-cache-v2";
const LOCATION_CACHE_TTL_MS = 7 * DAY_MS;
const LOCATION_CACHE_MAX_ENTRIES = 80;
const locationMemoryCache = new Map<string, { value: ResolvedSpotLocation; expiresAt: number }>();

// このファイルはサーバー/ワーカー向けビルド（DOM libなし）からもimportされる
// ため、グローバルの `window` 型に直接依存しない。ブラウザ実行時だけ
// localStorageへアクセスし、それ以外の環境ではメモリキャッシュのみを使う。
type BrowserStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
function browserLocalStorage(): BrowserStorageLike | undefined {
  const globalWindow = (globalThis as { window?: { localStorage?: BrowserStorageLike } }).window;
  return globalWindow?.localStorage;
}

function normalizedLocationQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ja");
}

function readCachedSpotLocation(query: string): ResolvedSpotLocation | null {
  const key = normalizedLocationQuery(query);
  if (!key) return null;
  const now = Date.now();
  const memory = locationMemoryCache.get(key);
  if (memory) {
    if (memory.expiresAt > now) return memory.value;
    locationMemoryCache.delete(key);
  }
  const storage = browserLocalStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(LOCATION_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, { value?: ResolvedSpotLocation; expiresAt?: number }>;
    const entry = parsed[key];
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now || !entry.value) {
      return null;
    }
    const latitude = Number(entry.value.latitude);
    const longitude = Number(entry.value.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || typeof entry.value.label !== "string") {
      return null;
    }
    const value = { latitude, longitude, label: entry.value.label };
    locationMemoryCache.set(key, { value, expiresAt: entry.expiresAt });
    return value;
  } catch {
    return null;
  }
}

function writeCachedSpotLocation(query: string, value: ResolvedSpotLocation): void {
  const key = normalizedLocationQuery(query);
  if (!key) return;
  const expiresAt = Date.now() + LOCATION_CACHE_TTL_MS;
  locationMemoryCache.set(key, { value, expiresAt });
  if (locationMemoryCache.size > LOCATION_CACHE_MAX_ENTRIES) {
    const firstKey = locationMemoryCache.keys().next().value;
    if (typeof firstKey === "string") locationMemoryCache.delete(firstKey);
  }
  const storage = browserLocalStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(LOCATION_CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, { value: ResolvedSpotLocation; expiresAt: number }> : {};
    parsed[key] = { value, expiresAt };
    const entries = Object.entries(parsed)
      .filter(([, entry]) => entry && typeof entry.expiresAt === "number" && entry.expiresAt > Date.now())
      .sort((left, right) => right[1].expiresAt - left[1].expiresAt)
      .slice(0, LOCATION_CACHE_MAX_ENTRIES);
    storage.setItem(LOCATION_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // localStorage が利用できない環境でも検索自体は継続する。
  }
}

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
    throw createAbortError("スポット検索を中止しました");
  }
}

export async function prefetchSpotLocation(
  query: string,
  signal?: AbortSignal
): Promise<void> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return;
  try {
    await resolveSpotLocation(normalizedQuery, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return;
    // 先読みはUX最適化であり、本検索のエラー表示には影響させない。
  }
}

// 2026-08-25追記: 成功結果のキャッシュ（readCachedSpotLocation）だけでは
// 「今まさに進行中の同一クエリへのリクエスト」を共有できない。確定検索の
// 連打や、UI操作の重複などで同じクエリが短時間に複数回呼ばれると、
// それぞれが独立してGoogleマップ等へ通信してしまい、429（レート制限）を
// 誘発しうる。進行中のPromiseをクエリ単位で共有し、二重に通信しないようにする。
const inFlightResolutions = new Map<string, Promise<ResolvedSpotLocation>>();

export async function resolveSpotLocation(
  query: string,
  signal?: AbortSignal
): Promise<ResolvedSpotLocation> {
  const normalizedQuery = query.trim();
  const cached = readCachedSpotLocation(normalizedQuery);
  if (cached) return cached;

  const existing = inFlightResolutions.get(normalizedQuery);
  if (existing) return existing;

  const task = resolveSpotLocationUncached(normalizedQuery, signal).finally(() => {
    inFlightResolutions.delete(normalizedQuery);
  });
  inFlightResolutions.set(normalizedQuery, task);
  return task;
}

async function resolveSpotLocationUncached(
  normalizedQuery: string,
  signal?: AbortSignal
): Promise<ResolvedSpotLocation> {
  const googleMapsUrl = extractGoogleMapsSharedUrl(normalizedQuery);
  if (googleMapsUrl) {
    const direct = extractGoogleMapsCoordinates(googleMapsUrl);
    if (direct) {
      const resolved = {
        ...direct,
        label: "Googleマップ共有地点",
      };
      writeCachedSpotLocation(normalizedQuery, resolved);
      return resolved;
    }
    if (canResolveGoogleMapsNatively()) {
      const nativeLocation = await resolveGoogleMapsSharedUrlNatively(
        googleMapsUrl,
        signal
      );
      const resolved = {
        latitude: nativeLocation.latitude,
        longitude: nativeLocation.longitude,
        label: "Googleマップ共有地点",
      };
      writeCachedSpotLocation(normalizedQuery, resolved);
      return resolved;
    }
    const response = await diagnosticFetch("google-maps-resolver", "/api/resolve-google-maps", {
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
    const resolved = {
      latitude: data.latitude,
      longitude: data.longitude,
      label:
        data.place?.name ??
        data.place?.formattedAddress ??
        data.label ??
        "Googleマップ共有地点",
    };
    writeCachedSpotLocation(normalizedQuery, resolved);
    return resolved;
  }

  let result: SearchResult | undefined;
  const apiResponse = await diagnosticFetch("geocode", "/api/geocode", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: normalizedQuery }),
    signal,
  });
  const apiIsJson = (apiResponse.headers.get("content-type") ?? "")
    .includes("application/json");
  if (apiResponse.ok && apiIsJson) {
    const location = await apiResponse.json() as {
      latitude?: unknown;
      longitude?: unknown;
      label?: unknown;
    };
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      typeof location.label === "string"
    ) {
      const resolved = { latitude, longitude, label: location.label };
      writeCachedSpotLocation(normalizedQuery, resolved);
      return resolved;
    }
    throw new Error("地名検索APIの応答座標が不正です");
  }
  if (apiIsJson) {
    const errorBody = await apiResponse.json() as { error?: unknown };
    throw new Error(
      typeof errorBody.error === "string"
        ? errorBody.error
        : `地名検索APIエラー：${apiResponse.status}`
    );
  }

  // バックグラウンドAPIを伴わない静的プレビューでだけ従来の直接検索へ戻す。
  // 本番・npm run devでは同一オリジンAPIを使い、ブラウザCORSや429の影響を避ける。
  const parameters = new URLSearchParams({
    q: normalizedQuery,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    namedetails: "1",
    countrycodes: "jp",
    "accept-language": "ja",
  });
  const directResponse = await fetch(
    `https://nominatim.openstreetmap.org/search?${parameters}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    }
  );
  if (!directResponse.ok) {
    throw new Error(`地名検索通信エラー：${directResponse.status}`);
  }
  result = ((await directResponse.json()) as SearchResult[])[0];
  if (!result) throw new Error("指定したスポットが見つかりませんでした");
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("検索地点の座標が不正です");
  }
  const resolved = { latitude, longitude, label: result.display_name };
  writeCachedSpotLocation(normalizedQuery, resolved);
  return resolved;
}

export async function resolveSpotTimeZone(
  location: Pick<ResolvedSpotLocation, "latitude" | "longitude">,
  fallback: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    return (await requestTimeZone(location.latitude, location.longitude, signal)) ?? fallback;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return fallback;
  }
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
  // 被写体ピンが建物・塔・山頂などの3D表面に置かれている場合、その高さは
  // 構図計算に必要な「狙う被写体点」そのもの。従来は検索開始時にDEM地表高で
  // 無条件上書きしていたため、被写体点を地面まで落とし、候補が全件不成立に
  // なっていた。3D表面高を優先し、無効値の場合だけDEM高へフォールバックする。
  const resolvedSubjectHeight = Number.isFinite(subject.height)
    ? subject.height
    : subjectGroundHeightMeters;
  const searchSubject: GroundPoint = {
    ...subject,
    height: Number.isFinite(resolvedSubjectHeight)
      ? resolvedSubjectHeight
      : 0,
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
  const allowedWeekdays = criteria.weekdays.length > 0
    ? new Set(criteria.weekdays)
    : null;

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
  let celestialMatchCount = 0;
  let coarseSamples: SearchSample[] = [];
  const progressReportInterval = Math.max(1, Math.ceil(sampleCount / 100));
  const explorationProgressPercent = (): number =>
    Math.min(
      90,
      10 + Math.floor(
        (checkedCount / Math.max(1, sampleCount)) * 80
      )
    );
  const currentSearchDateLabel = (): string =>
    zonedDateTimeLocalFromDate(sampleDate, timeZone)
      .replace("T", " ")
      .slice(0, 16);
  const explorationDetail = (prefix: string): string =>
    `${prefix}\n検索中 ${currentSearchDateLabel()}・` +
    `${checkedCount.toLocaleString()}/${sampleCount.toLocaleString()}時点を確認・` +
    `天体候補 ${celestialMatchCount.toLocaleString()}件・` +
    `確定 ${results.length}/${criteria.displayCount}件`;

  const refineWindow = async (samples: SearchSample[]): Promise<void> => {
    if (samples.length === 0 || results.length >= criteria.displayCount) return;
    abortIfRequested(signal);
    performanceTracker.enterPhase(10);
    onProgress?.(
      phaseMessage(
        10,
        explorationDetail(`候補日時${samples.length}件を精密探索中`)
      ),
      explorationProgressPercent(),
    );

    const azimuthBand = minimalAzimuthBand(
      samples.map((sample) => sample.horizontal.azimuthDegrees)
    );
    if (terrainPrefetcher && azimuthBand) {
      performanceTracker.enterPhase(7);
      onProgress?.(
        phaseMessage(
          7,
          explorationDetail("候補天体の必要方位帯だけ地形を先行取得しています")
        ),
        explorationProgressPercent(),
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
          (isAbortError(error))) {
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
            (isAbortError(error))) {
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
          } else {
            performanceTracker.increment("lineOfSightUnverifiedAccepted");
          }
          // 3D見通し判定はデータ欠損や地物精度の影響を受けるため、
          // 候補の削除条件にはせず、全候補をクライアント側の状態表示へ渡す。
          return entry;
        } catch (error) {
          if (signal?.aborted ||
            (isAbortError(error))) {
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
          // サーバー側のDEM確認後も、端末側Photorealistic 3D確認までは候補を残す。
          candidate3dStatus: "unverified",
          nearbyLandmarks: siteContext?.nearbyLandmarks ?? [],
          nearbyBuildings: siteContext?.nearbyBuildings ?? [],
          nearbyStructures: siteContext?.nearbyStructures ?? [],
        });
      }
      performanceTracker.enterPhase(11);
      onProgress?.(
        phaseMessage(
          11,
          explorationDetail("候補地点の見通しを確認しています")
        ),
        explorationProgressPercent(),
      );
    }
  };

  while (sampleDate.getTime() <= range.end.getTime()) {
    abortIfRequested(signal);
    checkedCount += 1;
    performanceTracker.increment("checkedSamples");
    const date = sampleDate;
    const localParts = localSearchDateParts(date, timeZone);
    const weekdayAllowed = allowedWeekdays === null ||
      allowedWeekdays.has(localParts.weekday);
    const timeAllowed = weekdayAllowed && isMinuteWithinSearchRange(
      localParts.minuteOfDay,
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
      celestialMatchCount += 1;
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

    if (
      checkedCount % progressReportInterval === 0 ||
      checkedCount >= sampleCount
    ) {
      const scanFraction = checkedCount / Math.max(1, sampleCount);
      const scanPhase = scanFraction < 0.5 ? 5 : 6;
      performanceTracker.enterPhase(scanPhase);
      onProgress?.(
        phaseMessage(
          scanPhase,
          explorationDetail("日時・天体条件を走査しています"),
        ),
        explorationProgressPercent(),
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
      94,
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
        (isAbortError(error))) {
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
    98,
  );
  const sortedResults = results.sort((a, b) => a.date.getTime() - b.date.getTime());
  const metrics = performanceTracker.complete(sortedResults.length);
  onPerformance?.(metrics);
  onProgress?.(
    phaseMessage(12, `検索結果を確定しました（所要時間 ${formatSearchDuration(metrics.totalMilliseconds)}）`),
    100,
  );
  return sortedResults;
}
