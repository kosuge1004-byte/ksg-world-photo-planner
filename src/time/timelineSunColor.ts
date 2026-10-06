// 時間軸スライダーの線の色（2026-10-07）。太陽高度から、昼・ゴールデンアワー・
// ブルーアワー・市民／航海／天文薄明・夜を色で示す。

/**
 * 太陽高度（度）ごとの色。間は直線的に混ぜる。
 *   −18以下        夜
 *   −18〜−12      天文薄明
 *   −12〜−6       航海薄明
 *   −6〜0         市民薄明（うち −6〜−4 がブルーアワー）
 *   −4〜+6        ゴールデンアワー
 *   +6以上         昼
 */
export const TIMELINE_SUN_COLOR_STOPS: ReadonlyArray<readonly [altitudeDegrees: number, r: number, g: number, b: number]> = [
  [-18, 22, 36, 104],    // 夜: 濃紺
  [-12, 27, 54, 150],   // 天文薄明の終わり: 紺
  [-6, 36, 93, 229],    // 航海薄明の終わり: 青（従来の線の色）
  [-5, 70, 185, 255],   // ブルーアワー: 明るい水色
  [-4, 120, 170, 240],  // ブルーアワー→ゴールデンアワーの境
  [-1, 255, 120, 90],   // 日の出・日の入り直前直後: 朱色
  [3, 255, 200, 40],    // ゴールデンアワー: 金色
  [6, 255, 140, 20],    // 昼: オレンジ
];

/** 太陽高度から線の色（CSSのrgb）を求める。 */
export function timelineSunColor(altitudeDegrees: number): string {
  const stops = TIMELINE_SUN_COLOR_STOPS;
  if (!Number.isFinite(altitudeDegrees) || altitudeDegrees <= stops[0][0]) {
    return `rgb(${stops[0][1]},${stops[0][2]},${stops[0][3]})`;
  }
  for (let index = 1; index < stops.length; index += 1) {
    const [upper, r1, g1, b1] = stops[index];
    if (altitudeDegrees > upper) continue;
    const [lower, r0, g0, b0] = stops[index - 1];
    const t = (altitudeDegrees - lower) / (upper - lower);
    const mix = (from: number, to: number) => Math.round(from + (to - from) * t);
    return `rgb(${mix(r0, r1)},${mix(g0, g1)},${mix(b0, b1)})`;
  }
  const last = stops[stops.length - 1];
  return `rgb(${last[1]},${last[2]},${last[3]})`;
}
