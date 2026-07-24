import type { GroundPoint } from "../types/points";
import type { RefractionCorrectionMode } from "../types/precision";

export type WeatherSample = {
  time: number;
  temperatureCelsius: number;
  relativeHumidityPercent: number;
  surfacePressureHpa: number;
};

export type RefractionWeatherContext = {
  requestedMode: RefractionCorrectionMode;
  effectiveMode: "standard" | "none" | "weather";
  source: "none" | "standard" | "forecast" | "climatology" | "fallback";
  samples: WeatherSample[];
  climatologyByMonthHour?: Record<string, Omit<WeatherSample, "time">>;
};

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
const FORECAST_CACHE_MS = 3 * 60 * 60_000;
const CLIMATOLOGY_CACHE_MS = 30 * 24 * 60 * 60_000;

function roundedCoordinate(value: number): string {
  return (Math.round(value * 20) / 20).toFixed(2);
}

function cacheKey(point: GroundPoint, source: "forecast" | "climatology"): string {
  return `${CACHE_PREFIX}${source}:${roundedCoordinate(point.latitude)}:${roundedCoordinate(point.longitude)}`;
}

function readCache(key: string): RefractionWeatherContext | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedWeather;
    if (!cached || cached.expiresAt <= Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return cached.context;
  } catch {
    return null;
  }
}

function writeCache(key: string, context: RefractionWeatherContext, ttlMs: number): void {
  try {
    const cached: CachedWeather = { expiresAt: Date.now() + ttlMs, context };
    localStorage.setItem(key, JSON.stringify(cached));
  } catch {
    // Storage quota/private mode failures must never stop a search.
  }
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
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`気象API HTTP ${response.status}`);
  return response.json() as Promise<OpenMeteoResponse>;
}

async function loadForecast(point: GroundPoint, signal: AbortSignal): Promise<RefractionWeatherContext> {
  const key = cacheKey(point, "forecast");
  const cached = readCache(key);
  if (cached) return cached;
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

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
    writeCache(key, context, FORECAST_CACHE_MS);
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
  const cached = readCache(key);
  if (cached) return cached;
  const existing = inFlightRequests.get(key);
  if (existing) return existing;

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
    writeCache(key, context, CLIMATOLOGY_CACHE_MS);
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
  mode: RefractionCorrectionMode;
  point: GroundPoint;
  searchStart: Date;
  searchEnd: Date;
  now: Date;
  signal: AbortSignal;
}): Promise<RefractionWeatherContext> {
  if (options.mode === "none") {
    return { requestedMode: "none", effectiveMode: "none", source: "none", samples: [] };
  }
  if (options.mode === "standard") {
    return { requestedMode: "standard", effectiveMode: "standard", source: "standard", samples: [] };
  }

  const sevenDaysAfterNow = options.now.getTime() + 7 * 24 * 60 * 60_000;
  const useForecast = options.searchStart.getTime() >= options.now.getTime() - 60_000
    && options.searchEnd.getTime() <= sevenDaysAfterNow;
  try {
    return useForecast
      ? await loadForecast(options.point, options.signal)
      : await loadClimatology(options.point, options.now, options.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { requestedMode: "auto", effectiveMode: "standard", source: "fallback", samples: [] };
  }
}

export function weatherForDate(
  context: RefractionWeatherContext,
  date: Date
): Omit<WeatherSample, "time"> | null {
  if (context.source === "forecast" && context.samples.length > 0) {
    const target = date.getTime();
    let low = 0;
    let high = context.samples.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (context.samples[mid].time < target) low = mid + 1;
      else high = mid;
    }
    const after = low < context.samples.length ? context.samples[low] : null;
    const before = low > 0 ? context.samples[low - 1] : null;
    const closest = before === null
      ? after
      : after === null
        ? before
        : target - before.time <= after.time - target ? before : after;
    if (closest === null || Math.abs(closest.time - target) > 90 * 60_000) return null;
    return closest;
  }
  if (context.source === "climatology" && context.climatologyByMonthHour) {
    return context.climatologyByMonthHour[`${date.getUTCMonth() + 1}-${date.getUTCHours()}`] ?? null;
  }
  return null;
}


const MIN_REFRACTION_ALTITUDE_DEGREES = -1;
const MAX_REFRACTION_ALTITUDE_DEGREES = 89.9;

function saturationVaporPressureHpa(temperatureCelsius: number): number {
  // Magnus equation over liquid water. Accurate enough for atmospheric refraction scaling.
  return 6.112 * Math.exp((17.62 * temperatureCelsius) / (243.12 + temperatureCelsius));
}

export function weatherRefractionCorrectionDegrees(
  geometricAltitudeDegrees: number,
  weather: Omit<WeatherSample, "time">
): number | null {
  const { temperatureCelsius, relativeHumidityPercent, surfacePressureHpa } = weather;
  if (
    !Number.isFinite(geometricAltitudeDegrees)
    || !Number.isFinite(temperatureCelsius)
    || !Number.isFinite(relativeHumidityPercent)
    || !Number.isFinite(surfacePressureHpa)
    || temperatureCelsius < -100
    || temperatureCelsius > 70
    || relativeHumidityPercent < 0
    || relativeHumidityPercent > 100
    || surfacePressureHpa < 300
    || surfacePressureHpa > 1100
  ) {
    return null;
  }

  if (geometricAltitudeDegrees < MIN_REFRACTION_ALTITUDE_DEGREES) return 0;
  if (geometricAltitudeDegrees > MAX_REFRACTION_ALTITUDE_DEGREES) return 0;

  const vaporPressureHpa = saturationVaporPressureHpa(temperatureCelsius)
    * relativeHumidityPercent / 100;
  // Water vapour is less refractive than the same partial pressure of dry air.
  const effectivePressureHpa = Math.max(0, surfacePressureHpa - 0.378 * vaporPressureHpa);
  const bennettArgumentDegrees = geometricAltitudeDegrees
    + 10.3 / (geometricAltitudeDegrees + 5.11);
  const tangent = Math.tan(bennettArgumentDegrees * Math.PI / 180);
  if (!Number.isFinite(tangent) || Math.abs(tangent) < 1e-8) return null;

  const correctionArcMinutes = (1.02 / tangent)
    * (effectivePressureHpa / 1010)
    * (283 / (273 + temperatureCelsius));
  if (!Number.isFinite(correctionArcMinutes) || correctionArcMinutes < 0) return null;
  return Math.min(1.5, correctionArcMinutes / 60);
}
