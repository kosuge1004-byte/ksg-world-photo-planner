import { getDeviceCache, setDeviceCache, clearDeviceCacheNamespace } from "./deviceCache";

/**
 * 2026-09-05追記（全面設計変更）: 「日時ごとに1候補だけ覚える」方式
 * （旧tripodRollingWindowCache.ts）は、以下の2点で根本的に間違っていた。
 *
 * 1. 三脚候補は「方位・高度」だけで決まり、日付には依存しない
 *    （buildCelestialBackwardRayが時刻を一切取らないことからも明らか）。
 *    にもかかわらず日付をキーにしていたため、同じ被写体・同じ方位でも
 *    日が違うだけで別物として扱われ、実質「全パターン」を覚えられない
 *    設計になっていた。
 * 2. 「日の出/日没/月の出/月の入りの瞬間（高度ちょうど0°）」を狙って
 *    いたが、探索コード自体が高度0.25°以下の天体を除外するため、
 *    保存される候補が常に空になっていた。
 *
 * 新設計は「方位ごとに、その方位線上の実測地形プロファイル（8m〜50km、
 * 通常探索の粗探索と同じ密度）を1回だけ保存する」。地形はどんな高度
 * （＝どんな日時）で見ても同じなので、一度取得したプロファイルは
 * その方位のあらゆる高度パターンに使い回せる。360方位ぶん保存すれば、
 * 文字通り「全方位・全高度パターン」を覆える。
 *
 * プロファイルはサーバーから実測した値そのものであり、端末側で
 * 座標を跨いだ補間・再解釈は行わない（同じ方位線上の点だけを扱うため、
 * 過去に問題になった「別地点への2D補間の再実装」とは性質が異なる）。
 */

const NAMESPACE_PREFIX = "tripod-bearing-profile-v1";
// 地形は変わらないので長期保持してよいが、安全側で1年に設定する。
const ENTRY_TTL_MS = 366 * 24 * 60 * 60 * 1000;
/**
 * 保存する方位の刻み幅。tripodBearingProfileManager.tsのALL_BEARINGS_
 * STEP_DEGREESと必ず同じ値にするため、ここで定義してマネージャー側から
 * importさせる。2箇所で別々の丸め幅を持つと、書き込み時（整数度）と
 * 読み出し時（別の丸め幅）がズレてキャッシュが常にミスする不具合になる
 * ——実際に一度、読み出し側だけ0.5°丸めのままにしてこの不具合を作って
 * しまった（書き込みは整数度のみなので0.5°丸めの結果とは基本的に一致せず、
 * 実質ずっとキャッシュミスし続けていた）。
 */
export const BEARING_STEP_DEGREES = 1;

export type BearingProfilePoint = {
  distanceMeters: number;
  longitude: number;
  latitude: number;
  /** 楕円体高（m）。通常探索のsampleWorldTerrain結果と同じ基準。 */
  ellipsoidalHeightMeters: number;
};

export type BearingProfileEntry = {
  bearingDegrees: number;
  points: BearingProfilePoint[];
  computedAtIso: string;
};

/** カメラ高をキーに使う際、浮動小数の誤差で別キー扱いにならないよう1cm単位に丸める。 */
export function roundCameraHeightForCacheKey(lensCenterHeightMeters: number): number {
  return Math.round(lensCenterHeightMeters * 100) / 100;
}

/** 方位をBEARING_STEP_DEGREES単位に丸める（保存側と読み出し側で必ず同じ関数を使うこと）。 */
export function roundBearingForCacheKey(bearingDegrees: number): number {
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return Math.round(normalized / BEARING_STEP_DEGREES) * BEARING_STEP_DEGREES;
}

function namespaceFor(subjectId: string): string {
  return `${NAMESPACE_PREFIX}:${subjectId}`;
}

function cacheKey(cameraHeightMeters: number, bearingDegrees: number): string {
  return `${roundCameraHeightForCacheKey(cameraHeightMeters)}:${roundBearingForCacheKey(bearingDegrees)}`;
}

export async function getBearingProfile(
  subjectId: string,
  cameraHeightMeters: number,
  bearingDegrees: number
): Promise<BearingProfileEntry | null> {
  return getDeviceCache<BearingProfileEntry>(
    { namespace: namespaceFor(subjectId), ttlMs: ENTRY_TTL_MS, maxEntries: 800 },
    cacheKey(cameraHeightMeters, bearingDegrees)
  );
}

export async function setBearingProfile(
  subjectId: string,
  cameraHeightMeters: number,
  bearingDegrees: number,
  entry: BearingProfileEntry
): Promise<void> {
  await setDeviceCache(
    { namespace: namespaceFor(subjectId), ttlMs: ENTRY_TTL_MS, maxEntries: 800 },
    cacheKey(cameraHeightMeters, bearingDegrees),
    entry
  );
}

export async function clearBearingProfileCacheForSubject(subjectId: string): Promise<void> {
  await clearDeviceCacheNamespace(namespaceFor(subjectId));
}
