import type { GroundPoint } from "../types/points";
import type { AccuracyMode, RefractionCorrectionMode } from "../types/precision";
import { diagnosticFetch, recordCacheDiagnostic } from "../network/networkDiagnostics";
import { DEVICE_CACHE_POLICIES } from "../cache/cachePolicies";
import { migrateLegacyLocalStorage, setDeviceCache } from "../cache/deviceCache";

import {
  weatherForDate,
  weatherRefractionCorrectionDegrees,
  type RefractionWeatherContext,
  type WeatherSample,
} from "./refractionWeatherModel";

export { weatherForDate, weatherRefractionCorrectionDegrees };
export type { RefractionWeatherContext, WeatherSample };

type OpenMeteoHourly = {
  time?: string[];
  temperature_2m?: Array<number | null>;
  relative_humidity_2m?: Array<number | null>;
  surface_pressure?: Array<number | null>;
};

type OpenMeteoResponse = { hourly?: OpenMeteoHourly };

type CachedWeather = { expiresAt: number; context: RefractionWeatherContext };

const inFlightRequests = new Map<string, Promise<RefractionWeatherContext>>();

const CACHE_PREFIX = "ksg-refraction-weather-v1:";
const FORECAST_CACHE_MS = DEVICE_CACHE_POLICIES.weatherForecast.ttlMs;
const HISTORICAL_CACHE_MS = DEVICE_CACHE_POLICIES.weatherHistorical.ttlMs;
const CLIMATOLOGY_CACHE_MS = DEVICE_CACHE_POLICIES.weatherClimatology.ttlMs;

function roundedCoordinate(value: number): string {
  return (Math.round(value * 20) / 20).toFixed(2);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function cacheKey(
  point: GroundPoint,
  source: "forecast" | "historical" | "climatology",
  range?: { start: Date; end: Date }
): string {
  const base = `${CACHE_PREFIX}${source}:${roundedCoordinate(point.latitude)}:${roundedCoordinate(point.longitude)}`;
  if (source !== "historical" || !range) return base;
  return `${base}:${utcDateKey(range.start)}:${utcDateKey(range.end)}`;
}

async function readCache(
  key: string,
  source: "forecast" | "historical" | "climatology"
): Promise<RefractionWeatherContext | null> {
  const policy = source === "forecast"
    ? DEVICE_CACHE_POLICIES.weatherForecast
    : source === "historical"
      ? DEVICE_CACHE_POLICIES.weatherHistorical
      : DEVICE_CACHE_POLICIES.weatherClimatology;
  const persistentKey = key.slice(CACHE_PREFIX.length);
  return migrateLegacyLocalStorage<RefractionWeatherContext>({
    policy,
    key: persistentKey,
    legacyKey: key,
    parse: (raw) => {
      try {
        const cached = JSON.parse(raw) as CachedWeather;
        if (!cached || !Number.isFinite(cached.expiresAt) || !cached.context) return null;
        return { value: cached.context, expiresAt: cached.expiresAt };
      } catch {
        return null;
      }
    },
  });
}

async function writeCache(
  key: string,
  source: "forecast" | "historical" | "climatology",
  context: RefractionWeatherContext,
  ttlMs: number
): Promise<void> {
  const policy = source === "forecast"
    ? DEVICE_CACHE_POLICIES.weatherForecast
    : source === "historical"
      ? DEVICE_CACHE_POLICIES.weatherHistorical
      : DEVICE_CACHE_POLICIES.weatherClimatology;
  await setDeviceCache(policy, key.slice(CACHE_PREFIX.length), context, ttlMs);
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseUtcIsoTime(value: string): number {
  // Open-Meteo returns timezone=GMT timestamps without an explicit Z suffix.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

function parseSamples(hourly: OpenMeteoHourly | undefined): WeatherSample[] {
  if (!hourly?.time) return [];
  const samples: WeatherSample[] = [];
  for (let index = 0; index < hourly.time.length; index += 1) {
    const temperature = hourly.temperature_2m?.[index];
    const humidity = hourly.relative_humidity_2m?.[index];
    const pressure = hourly.surface_pressure?.[index];
    const time = parseUtcIsoTime(hourly.time[index]);
    if (!Number.isFinite(time) || !finite(temperature) || !finite(humidity) || !finite(pressure)) continue;
    samples.push({
      time,
      temperatureCelsius: temperature,
      relativeHumidityPercent: humidity,
      surfacePressureHpa: pressure,
    });
  }
  return samples;
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<OpenMeteoResponse> {
  const response = await diagnosticFetch("weather", url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`気象API HTTP ${response.status}`);
  return response.json() as Promise<OpenMeteoResponse>;
}

async function loadForecast(point: GroundPoint, signal: AbortSignal): Promise<RefractionWeatherContext> {
  const key = cacheKey(point, "forecast");
  const cached = await readCache(key, "forecast");
  if (cached) {
    recordCacheDiagnostic("weather", key, "cache-hit");
    return cached;
  }
  recordCacheDiagnostic("weather", key, "cache-miss");
  const existing = inFlightRequests.get(key);
  if (existing) {
    recordCacheDiagnostic("weather", key, "deduplicated");
    return existing;
  }

  const request = (async () => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(point.latitude));
    url.searchParams.set("longitude", String(point.longitude));
    url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,surface_pressure");
    url.searchParams.set("forecast_days", "7");
    url.searchParams.set("timeformat", "iso8601");
    url.searchParams.set("timezone", "GMT");
    const json = await fetchJson(url, signal);
    const samples = parseSamples(json.hourly).sort((a, b) => a.time - b.time);
    if (samples.length === 0) throw new Error("予報データが空です");
    const context: RefractionWeatherContext = {
      requestedMode: "auto",
      effectiveMode: "weather",
      source: "forecast",
      samples,
    };
    void writeCache(key, "forecast", context, FORECAST_CACHE_MS).catch(() => undefined);
    return context;
  })();
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

async function loadHistorical(
  point: GroundPoint,
  searchStart: Date,
  searchEnd: Date,
  signal: AbortSignal
): Promise<RefractionWeatherContext> {
  // timezone=GMT の時系列から検索対象時刻を確実に内包するため、UTC日単位に丸める。
  const range = { start: startOfUtcDay(searchStart), end: endOfUtcDay(searchEnd) };
  const key = cacheKey(point, "historical", range);
  const cached = await readCache(key, "historical");
  if (cached) {
    recordCacheDiagnostic("weather", key, "cache-hit");
    return cached;
  }
  recordCacheDiagnostic("weather", key, "cache-miss");
  const existing = inFlightRequests.get(key);
  if (existing) {
    recordCacheDiagnostic("weather", key, "deduplicated");
    return existing;
  }

  const request = (async () => {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", String(point.latitude));
    url.searchParams.set("longitude", String(point.longitude));
    url.searchParams.set("start_date", utcDateKey(range.start));
    url.searchParams.set("end_date", utcDateKey(range.end));
    url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,surface_pressure");
    url.searchParams.set("timeformat", "iso8601");
    url.searchParams.set("timezone", "GMT");
    const json = await fetchJson(url, signal);
    const samples = parseSamples(json.hourly).sort((a, b) => a.time - b.time);
    if (samples.length === 0) throw new Error("過去実績気象データが空です");
    const context: RefractionWeatherContext = {
      requestedMode: "auto",
      effectiveMode: "weather",
      source: "historical",
      samples,
    };
    void writeCache(key, "historical", context, HISTORICAL_CACHE_MS).catch(() => undefined);
    return context;
  })();
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  }
}

function climatology(samples: WeatherSample[]): Record<string, Omit<WeatherSample, "time">> {
  const sums = new Map<string, { temperature: number; humidity: number; pressure: number; count: number }>();
  for (const sample of samples) {
    const date = new Date(sample.time);
    const key = `${date.getUTCMonth() + 1}-${date.getUTCHours()}`;
    const sum = sums.get(key) ?? { temperature: 0, humidity: 0, pressure: 0, count: 0 };
    sum.temperature += sample.temperatureCelsius;
    sum.humidity += sample.relativeHumidityPercent;
    sum.pressure += sample.surfacePressureHpa;
    sum.count += 1;
    sums.set(key, sum);
  }
  const result: Record<string, Omit<WeatherSample, "time">> = {};
  for (const [key, sum] of sums) {
    result[key] = {
      temperatureCelsius: sum.temperature / sum.count,
      relativeHumidityPercent: sum.humidity / sum.count,
      surfacePressureHpa: sum.pressure / sum.count,
    };
  }
  return result;
}

async function loadClimatology(point: GroundPoint, now: Date, signal: AbortSignal): Promise<RefractionWeatherContext> {
  const key = cacheKey(point, "climatology");
  const cached = await readCache(key, "climatology");
  if (cached) {
    recordCacheDiagnostic("weather", key, "cache-hit");
    return cached;
  }
  recordCacheDiagnostic("weather", key, "cache-miss");
  const existing = inFlightRequests.get(key);
  if (existing) {
    recordCacheDiagnostic("weather", key, "deduplicated");
    return existing;
  }

  const request = (async () => {
    const lastCompleteYear = now.getUTCFullYear() - 1;
    const firstYear = lastCompleteYear - 4;
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", String(point.latitude));
    url.searchParams.set("longitude", String(point.longitude));
    url.searchParams.set("start_date", `${firstYear}-01-01`);
    url.searchParams.set("end_date", `${lastCompleteYear}-12-31`);
    url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,surface_pressure");
    url.searchParams.set("timeformat", "iso8601");
    url.searchParams.set("timezone", "GMT");
    const json = await fetchJson(url, signal);
    const samples = parseSamples(json.hourly);
    if (samples.length === 0) throw new Error("平年用気象データが空です");
    const context: RefractionWeatherContext = {
      requestedMode: "auto",
      effectiveMode: "weather",
      source: "climatology",
      samples: [],
      climatologyByMonthHour: climatology(samples),
    };
    void writeCache(key, "climatology", context, CLIMATOLOGY_CACHE_MS).catch(() => undefined);
    return context;
  })();
  inFlightRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
  }
}

export async function prepareRefractionWeatherContext(options: {
  accuracyMode: AccuracyMode;
  mode: RefractionCorrectionMode;
  point: GroundPoint;
  searchStart: Date;
  searchEnd: Date;
  now: Date;
  signal: AbortSignal;
}): Promise<RefractionWeatherContext> {
  // 精度モードは従量制サービスの利用可否だけを切り替える。
  // 予報・平年気象データによる屈折補正は従量制ではないため、
  // 標準／Googleタイルの両モードで同じ処理を使用する。
  void options.accuracyMode;
  if (options.mode === "standard") {
    return { requestedMode: "standard", effectiveMode: "standard", source: "standard", samples: [] };
  }

  const nowMs = options.now.getTime();
  const sevenDaysAfterNow = nowMs + 7 * 24 * 60 * 60_000;
  const rangeIsPast = options.searchEnd.getTime() < nowMs - 60_000;
  // 「過去の日付」は平年値ではなく、その日時の過去気象（再解析）を使う。
  // 当日～7日先は従来の予報、7日より先だけ平年値を使用する。
  const useForecast = !rangeIsPast && options.searchEnd.getTime() <= sevenDaysAfterNow;
  try {
    if (rangeIsPast) {
      return await loadHistorical(
        options.point,
        options.searchStart,
        options.searchEnd,
        options.signal
      );
    }
    return useForecast
      ? await loadForecast(options.point, options.signal)
      : await loadClimatology(options.point, options.now, options.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { requestedMode: "auto", effectiveMode: "standard", source: "fallback", samples: [] };
  }
}

