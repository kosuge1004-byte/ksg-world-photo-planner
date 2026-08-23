import type { RefractionCorrectionMode } from "../types/precision";

export type WeatherSample = {
  time: number;
  temperatureCelsius: number;
  relativeHumidityPercent: number;
  surfacePressureHpa: number;
};

export type RefractionWeatherContext = {
  requestedMode: RefractionCorrectionMode;
  effectiveMode: "standard" | "weather";
  source: "standard" | "forecast" | "climatology" | "fallback";
  samples: WeatherSample[];
  climatologyByMonthHour?: Record<string, Omit<WeatherSample, "time">>;
};

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
