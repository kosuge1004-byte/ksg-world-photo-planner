/**
 * 標高タイル（GSI DEM等）の格子点をBilinear補間するための共通実装。
 *
 * これまでのDEM標高取得は、問い合わせ座標が属するピクセルを
 * Math.floorで1つだけ選ぶ「最近傍（nearest）」方式だった。
 * 隣接ピクセルとの間で標高が階段状に変化するため、被写体・地形稜線の
 * 仰角計算に最大で格子間隔の半分（GSI 5mメッシュで最大2.5m相当）の
 * 標高誤差が乗る可能性があった。
 *
 * Bilinear補間は、問い合わせ座標を囲む4点（左上・右上・左下・右下）の
 * 標高を、座標が各点からどれだけ離れているかの比率で加重平均する。
 * これにより格子間の標高変化を線形に近似し、階段状の誤差を解消する。
 */

export type BilinearCorners = {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
};

/**
 * 4隅の値とタイル内の小数座標（0〜1）からBilinear補間値を求める。
 * fracX: 左端からの水平方向の位置（0=左端、1=右端）
 * fracY: 上端からの垂直方向の位置（0=上端、1=下端）
 */
export function bilinearInterpolate(
  corners: BilinearCorners,
  fracX: number,
  fracY: number
): number {
  const clampedX = Math.max(0, Math.min(1, fracX));
  const clampedY = Math.max(0, Math.min(1, fracY));
  const top = corners.topLeft + (corners.topRight - corners.topLeft) * clampedX;
  const bottom = corners.bottomLeft + (corners.bottomRight - corners.bottomLeft) * clampedX;
  return top + (bottom - top) * clampedY;
}
