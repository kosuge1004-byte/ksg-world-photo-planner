/**
 * 地上見通し線用の地球曲率・地表屈折モデル。
 *
 * k-factor は光線の曲率を地球曲率に対する比として表す。標準値 k=0.13。
 * 有効地球半径は R/(1-k) となる。
 *
 * 注意: 地上の気温・気圧・湿度だけでは k の決定に必要な鉛直屈折率勾配を
 * 求められない。Phase4-5では根拠のない気象推定を行わず、標準値と明示的に
 * 与えられた係数だけを使用する。天体のBennett系大気差とは別系統である。
 */

export const STANDARD_TERRESTRIAL_K_FACTOR = 0.13;
export const MINIMUM_TERRESTRIAL_K_FACTOR = -0.2;
export const MAXIMUM_TERRESTRIAL_K_FACTOR = 0.5;
export const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;

export type TerrestrialRefractionModel = {
  kFactor: number;
  source: "standard" | "measured-gradient" | "disabled";
};

export const STANDARD_TERRESTRIAL_REFRACTION_MODEL: TerrestrialRefractionModel = {
  kFactor: STANDARD_TERRESTRIAL_K_FACTOR,
  source: "standard",
};

export const DISABLED_TERRESTRIAL_REFRACTION_MODEL: TerrestrialRefractionModel = {
  kFactor: 0,
  source: "disabled",
};

export function normalizeTerrestrialKFactor(value: number): number {
  if (!Number.isFinite(value)) return STANDARD_TERRESTRIAL_K_FACTOR;
  return Math.min(MAXIMUM_TERRESTRIAL_K_FACTOR, Math.max(MINIMUM_TERRESTRIAL_K_FACTOR, value));
}

/** 有効地球半径 R/(1-k)。 */
export function effectiveEarthRadiusMeters(kFactor = STANDARD_TERRESTRIAL_K_FACTOR): number {
  const k = normalizeTerrestrialKFactor(kFactor);
  return EARTH_MEAN_RADIUS_METERS / (1 - k);
}

/**
 * ECEFで計算済みの幾何学仰角へ加える地表屈折量。
 * 地球曲率そのものはECEF側に含まれるため、ここでは屈折分 k*d/(2R) だけを加える。
 */
export function terrestrialRefractionCorrectionDegrees(
  distanceMeters: number,
  kFactor = STANDARD_TERRESTRIAL_K_FACTOR
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  const k = normalizeTerrestrialKFactor(kFactor);
  return (k * distanceMeters / (2 * EARTH_MEAN_RADIUS_METERS)) * 180 / Math.PI;
}

/**
 * 平面距離・高さ差から地球曲率と屈折を同時に扱う場合の曲率落差。
 * サーバー側のOSM建物・植生など、ECEFを使わない計算向け。
 */
export function effectiveEarthCurvatureDropMeters(
  distanceMeters: number,
  kFactor = STANDARD_TERRESTRIAL_K_FACTOR
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  const radius = effectiveEarthRadiusMeters(kFactor);
  return distanceMeters * distanceMeters / (2 * radius);
}

/** k=0.05〜0.20の通常変動幅による片側不確かさ。 */
export function terrestrialRefractionUncertaintyDegrees(distanceMeters: number): number {
  const upper = terrestrialRefractionCorrectionDegrees(distanceMeters, 0.2);
  const lower = terrestrialRefractionCorrectionDegrees(distanceMeters, 0.05);
  return Math.max(0, (upper - lower) / 2);
}
