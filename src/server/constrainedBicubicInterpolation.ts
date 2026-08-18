/**
 * 制約付き二次元三次補間。
 *
 * Catmull-Rom型のcubic convolutionを2軸へ適用し、補間結果を中央2x2セルの
 * 最小値・最大値へ制限する。これにより三次補間特有のオーバーシュートで
 * 実在しない山頂・窪地を生成しない。
 *
 * 4x4近傍が取得できない場合やNO_DATAを含む場合は呼び出し側でBilinearへ
 * フォールバックすること。
 */
export type BicubicGrid4x4 = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function cubicCatmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number
): number {
  const u = clamp01(t);
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const a2 = -0.5 * p0 + 0.5 * p2;
  const a3 = p1;
  return ((a0 * u + a1) * u + a2) * u + a3;
}

export function constrainedBicubicInterpolate(
  grid: BicubicGrid4x4,
  fracX: number,
  fracY: number
): number {
  const rows = grid.map((row) => cubicCatmullRom(
    row[0], row[1], row[2], row[3], fracX
  )) as [number, number, number, number];
  const raw = cubicCatmullRom(rows[0], rows[1], rows[2], rows[3], fracY);

  // 問い合わせ点を囲む中央セルだけを物理的な許容範囲とする。
  const center = [grid[1][1], grid[1][2], grid[2][1], grid[2][2]];
  const minimum = Math.min(...center);
  const maximum = Math.max(...center);
  return Math.max(minimum, Math.min(maximum, raw));
}
