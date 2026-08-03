/**
 * 被写体・地形稜線など地上の見通し線に対する大気差（地表屈折）補正。
 *
 * これまで天体（太陽・月・星）側にのみ大気差を適用し、地上の見通し線には
 * 幾何学的な直線（屈折なし）を使っていたため、両者の間に非対称な補正漏れが
 * あった。ここでは測量分野で広く使われる平均的な地表屈折係数 k≈0.13 を用い、
 * 見通し距離に比例する角度分だけ見かけ高度を引き上げる。
 *
 * 地表屈折係数 k は気温の高度分布に強く依存し、快晴日中は 0.05 程度、
 * 早朝や水面上では 0.2 を超えることもあり、強い逆転層下では負にもなり得る
 * （逃げ水・浮島現象）。そのため、この補正はあくまで平均的な近似であり、
 * 特に長距離・低高度では依然として数分角オーダーの残差が生じ得る。
 * terrestrialRefractionUncertaintyDegrees() はこの残差の目安を返す。
 */

const TERRESTRIAL_REFRACTION_COEFFICIENT = 0.13;
// k の実用的な変動幅の目安（快晴〜通常条件、異常気象時はさらに外れ得る）。
const TERRESTRIAL_REFRACTION_COEFFICIENT_MIN = 0.05;
const TERRESTRIAL_REFRACTION_COEFFICIENT_MAX = 0.2;
const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;

function curvatureAngleDegrees(
  coefficient: number,
  distanceMeters: number
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return 0;
  const radians =
    (coefficient * distanceMeters) / (2 * EARTH_MEAN_RADIUS_METERS);
  return (radians * 180) / Math.PI;
}

/**
 * 見通し距離に応じた地表屈折による見かけ高度の引き上げ量（度）。
 * 平均的な k=0.13 を使用する。
 */
export function terrestrialRefractionCorrectionDegrees(
  distanceMeters: number
): number {
  return curvatureAngleDegrees(TERRESTRIAL_REFRACTION_COEFFICIENT, distanceMeters);
}

/**
 * k の実用的な変動幅（0.05〜0.2）から生じる補正量の不確かさ（度、片側）。
 * 遮蔽判定の未確定帯を距離に応じて広げる目的で使用する。
 */
export function terrestrialRefractionUncertaintyDegrees(
  distanceMeters: number
): number {
  const upper = curvatureAngleDegrees(TERRESTRIAL_REFRACTION_COEFFICIENT_MAX, distanceMeters);
  const lower = curvatureAngleDegrees(TERRESTRIAL_REFRACTION_COEFFICIENT_MIN, distanceMeters);
  return Math.max(0, (upper - lower) / 2);
}
