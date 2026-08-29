import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { getDeviceCacheMany, setDeviceCacheMany, clearDeviceCacheNamespace, type DeviceCachePolicy } from "../cache/deviceCache";

/**
 * Persistent *hint* cache only. These values are never accepted as final answers.
 * A miss or stale/wrong hint simply falls back to the existing full DEM search.
 */
const POLICY: DeviceCachePolicy = {
  namespace: "tripod-candidate-seed-v1",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 512,
  memoryEntries: 128,
};
// 2026-08-29修正: 誤って「確定」扱いになった候補が永続保存され、以後の
// 検索へ自己強化的に悪影響を与え続ける事例が実機で確認された（詳細は
// clearPersistentTripodSeeds()のコメント参照）。バージョン文字列を
// 変更するだけで、既存の永続データはキーが一致しなくなり自動的に無効化
// される（明示的な削除・移行処理は不要）。今回の更新を機に、これまでに
// 保存された可能性のある誤ったseedを一括で無効化する。
const SEED_VERSION = "tripod-seed-20260829-v2";

export type PersistentTripodSeed = {
  distanceMeters: number;
  latitude: number;
  longitude: number;
  height: number;
  savedAt: number;
};

function bucket(value: number, step: number): string {
  return String(Math.round(value / step));
}

function keyFor(subject: GroundPoint, point: CelestialScreenPoint): string {
  // Subject ~11 m, azimuth 0.5°, altitude 0.5°. This is deliberately only a
  // relevance bucket; the seed is never trusted as a result and the solver's
  // full-scan fallback remains authoritative.
  return [
    SEED_VERSION,
    bucket(subject.latitude, 0.0001),
    bucket(subject.longitude, 0.0001),
    point.id,
    bucket(point.azimuthDegrees, 0.5),
    bucket(point.geometricAltitudeDegrees ?? point.altitudeDegrees, 0.5),
  ].join("|");
}

export async function loadPersistentTripodSeeds(
  subject: GroundPoint,
  points: CelestialScreenPoint[]
): Promise<Partial<Record<CelestialScreenPoint["id"], PersistentTripodSeed>>> {
  const keys = points.map((point) => keyFor(subject, point));
  const seeds = await getDeviceCacheMany<PersistentTripodSeed>(POLICY, keys);
  const entries = points.map((point, index) => {
    const seed = seeds[index];
    if (!seed || !Number.isFinite(seed.distanceMeters) || seed.distanceMeters <= 0) return null;
    return [point.id, seed] as const;
  });
  return Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}

export async function savePersistentTripodSeeds(
  subject: GroundPoint,
  points: CelestialScreenPoint[],
  candidates: TripodCandidate[]
): Promise<void> {
  const byId = new Map<CelestialScreenPoint["id"], TripodCandidate>();
  for (const candidate of candidates) {
    if (candidate.solutionType !== "aligned") continue;
    const current = byId.get(candidate.id);
    if (!current || candidate.distanceMeters > current.distanceMeters) byId.set(candidate.id, candidate);
  }
  const savedAt = Date.now();
  const entries = points.flatMap((point) => {
    const candidate = byId.get(point.id);
    if (!candidate) return [];
    return [{
      key: keyFor(subject, point),
      value: {
        distanceMeters: candidate.distanceMeters,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        height: candidate.height,
        savedAt,
      } satisfies PersistentTripodSeed,
    }];
  });
  await setDeviceCacheMany<PersistentTripodSeed>(POLICY, entries);
}

/**
 * 2026-08-29追記: 「以前は正確だったのに、いつからか同じ誤った距離
 * （例: 1252m付近）で確定し続ける」という報告を調査した結果、この
 * 永続seedキャッシュ自体が原因だった。一度でも誤って「確定」扱いに
 * なった候補がsavePersistentTripodSeeds()で保存されると、以後同じ
 * 被写体・天体・方位帯（0.5°）・高度帯（0.5°）に該当する検索
 * （日付・時刻は区別しない）で毎回そのままヒントとして再利用され、
 * 誤りが自己強化的に持続してしまう（コード側の修正だけでは、既に
 * 端末に保存済みのこの値は消えない）。この関数で該当namespaceの
 * 永続データを利用者の操作から即座に消去できるようにする。
 */
export async function clearPersistentTripodSeeds(): Promise<void> {
  await clearDeviceCacheNamespace(POLICY.namespace);
}
