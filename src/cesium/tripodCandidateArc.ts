import type { TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { calculateKarneySurfaceMetrics } from "../geodesy/karneyGeodesic";

export type OrderedTripodCandidateArcPoint = TripodCandidate & {
  bearingFromSubjectDegrees: number;
};

/**
 * 確定三脚候補を被写体の周囲の方位順へ並べる。
 *
 * 0/360度を単純な配列端として扱うと、北をまたぐ短い円弧が地図を一周する
 * 長い線に見える。最大の空白方位区間で配列を切り、候補が存在する側だけを
 * 連続線にする。候補座標や高さは変更せず、表示順だけを決める。
 */
export function orderTripodCandidatesForArc(
  subject: Pick<GroundPoint, "latitude" | "longitude"> | null,
  candidates: readonly TripodCandidate[]
): OrderedTripodCandidateArcPoint[] {
  if (!subject) return [];

  const unique = new Map<string, OrderedTripodCandidateArcPoint>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) continue;
    const metrics = calculateKarneySurfaceMetrics(subject, candidate);
    if (metrics.distanceMeters <= 0) continue;
    const key = `${candidate.latitude.toFixed(9)}:${candidate.longitude.toFixed(9)}:${candidate.height.toFixed(3)}`;
    unique.set(key, {
      ...candidate,
      bearingFromSubjectDegrees: metrics.bearingDegrees,
    });
  }

  const sorted = [...unique.values()].sort((a, b) =>
    a.bearingFromSubjectDegrees - b.bearingFromSubjectDegrees ||
    a.distanceMeters - b.distanceMeters
  );
  if (sorted.length < 2) return sorted;

  let largestGapIndex = sorted.length - 1;
  let largestGapDegrees = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index].bearingFromSubjectDegrees;
    const next = index + 1 < sorted.length
      ? sorted[index + 1].bearingFromSubjectDegrees
      : sorted[0].bearingFromSubjectDegrees + 360;
    const gap = next - current;
    if (gap > largestGapDegrees) {
      largestGapDegrees = gap;
      largestGapIndex = index;
    }
  }

  const start = (largestGapIndex + 1) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}
