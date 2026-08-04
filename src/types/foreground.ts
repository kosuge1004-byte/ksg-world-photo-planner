export type ForegroundObjectType = "person";

export const FOREGROUND_HEIGHT_MIN_CM = 50;
export const FOREGROUND_HEIGHT_MAX_CM = 300;
export const DEFAULT_FOREGROUND_HEIGHT_CM = 170;

/**
 * Person height is stored throughout the app in centimetres.
 * Convert to metres only at the geometry/projection boundary.
 */
export function normalizeForegroundHeightCm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FOREGROUND_HEIGHT_CM;
  return Math.max(
    FOREGROUND_HEIGHT_MIN_CM,
    Math.min(FOREGROUND_HEIGHT_MAX_CM, Math.round(value))
  );
}

export function foregroundHeightCmToMeters(heightCm: number): number {
  return normalizeForegroundHeightCm(heightCm) / 100;
}

export type ForegroundObject = {
  id: string;
  type: ForegroundObjectType;
  latitude: number;
  longitude: number;
  /** Terrain height at the object's own placement point, in meters. */
  groundHeightMeters?: number;
  /** Physical person height in centimetres. Example: 170 means 1.70 m. */
  heightCm: number;
  enabled: boolean;
};
