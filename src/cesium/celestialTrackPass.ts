// 2026-10-07: 上部プレビューの「天体が通る線」を、今見ている1回の通過だけに絞る。
//
// 軌跡は深夜をまたいでも途切れないよう選択日の前後へ延長して計算している。
// そのため月のように毎日約50分ずつ遅れて昇る天体では、延長した範囲に翌日（または前日）の
// 通過も入り、少しずれた線が2本描かれていた。

import type { CelestialTrack, CelestialTrackPoint } from "../types/celestial";

/** CelestialOverlay が線を切る高度と同じ。これ未満は地平線の下として通過を区切る。 */
const PASS_MINIMUM_ALTITUDE_DEGREES = -1;

/**
 * 軌跡を「地平線より上にいる連続した区間（1回の通過）」に分け、
 * 指定時刻を含む通過だけを残す。含む通過が無い（天体が沈んでいる）場合は、
 * 時刻が最も近い通過を残す。
 */
export function selectCelestialTrackPass(
  track: CelestialTrack,
  timestampMilliseconds: number
): CelestialTrack {
  const passes: CelestialTrackPoint[][] = [];
  let current: CelestialTrackPoint[] = [];
  for (const point of track.points) {
    if (point.altitudeDegrees >= PASS_MINIMUM_ALTITUDE_DEGREES) {
      current.push(point);
    } else if (current.length > 0) {
      passes.push(current);
      current = [];
    }
  }
  if (current.length > 0) passes.push(current);
  if (passes.length <= 1 || !Number.isFinite(timestampMilliseconds)) return track;

  let best = passes[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const pass of passes) {
    const start = pass[0].timestampMilliseconds;
    const end = pass[pass.length - 1].timestampMilliseconds;
    const gap = timestampMilliseconds < start
      ? start - timestampMilliseconds
      : timestampMilliseconds > end
        ? timestampMilliseconds - end
        : 0;
    if (gap < bestGap) {
      best = pass;
      bestGap = gap;
    }
  }
  return { ...track, points: best };
}
