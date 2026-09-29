import type { GroundPoint } from "../types/points";
import { ellipsoidalHeightMeters, orthometricHeightMeters } from "../types/points";
import { MIN_STRUCTURE_CLEARANCE_METERS, selectSubjectSurfacePoint } from "./subjectSurfaceResolution";

/**
 * 2026-09-29: 高さ未登録の登録スポット（城・寺社・観覧車など113件）への対策。
 *
 * 1. 水平位置の固定: PLATEAU屋根探索は頂上候補の緯度経度をそのまま採用するため、
 *    登録座標から最大約50m動き、計算済み三脚候補データ（登録座標の7桁一致キー）を
 *    引けなくなっていた。登録スポットは「登録座標＋高さ」で定義する（既知高さを
 *    持つ東京スカイツリー等と同じ規則）。屋根/OSMは高さだけを提供する。
 * 2. 学習済み高さ: 一度でも屋根/OSMで頂上高を確定できた登録スポットは、地表からの
 *    構造物高さを端末に保存し、次回PLATEAU/OSMが取れない時の代替に使う。
 * 3. 最終手段: それでも高さが無い場合はエラーで止めず、登録座標の地表高で
 *    「高さ未確定」の仮配置にする（呼び出し側が警告を表示する）。
 */

const LEARNED_HEIGHT_STORAGE_KEY = "ksg-registered-structure-height-v1";
const LEARNED_HEIGHT_MAX_ENTRIES = 512;
/** 地表からの構造物高さとして妥当な上限（東京スカイツリー634mを含む）。 */
const MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS = 700;

export type RegisteredStructureAnchor = {
  name: string;
  latitude: number;
  longitude: number;
};

type LearnedHeightRecord = {
  heightMeters: number;
  source: string;
  savedAtIso: string;
};

function anchorKey(anchor: RegisteredStructureAnchor): string {
  return `${anchor.name}@${anchor.latitude.toFixed(7)},${anchor.longitude.toFixed(7)}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, LearnedHeightRecord> {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(LEARNED_HEIGHT_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, LearnedHeightRecord>
      : {};
  } catch {
    return {};
  }
}

function plausibleHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= MIN_STRUCTURE_CLEARANCE_METERS &&
    value <= MAX_PLAUSIBLE_STRUCTURE_HEIGHT_METERS;
}

export function readLearnedStructureHeight(anchor: RegisteredStructureAnchor): number | null {
  const record = readAll()[anchorKey(anchor)];
  return record && plausibleHeight(record.heightMeters) ? record.heightMeters : null;
}

/** 屋根/OSMで確定した頂上点から、地表からの構造物高さを保存する。 */
export function rememberStructureHeight(
  anchor: RegisteredStructureAnchor,
  groundPoint: GroundPoint,
  resolvedTop: GroundPoint
): void {
  const store = storage();
  if (!store) return;
  let heightMeters: number;
  try {
    heightMeters = ellipsoidalHeightMeters(resolvedTop) - ellipsoidalHeightMeters(groundPoint);
  } catch {
    return;
  }
  if (!plausibleHeight(heightMeters)) return;
  const all = readAll();
  all[anchorKey(anchor)] = {
    heightMeters,
    source: resolvedTop.heightSource ?? "unknown",
    savedAtIso: new Date().toISOString(),
  };
  const keys = Object.keys(all);
  if (keys.length > LEARNED_HEIGHT_MAX_ENTRIES) {
    keys
      .sort((a, b) => (all[a].savedAtIso < all[b].savedAtIso ? -1 : 1))
      .slice(0, keys.length - LEARNED_HEIGHT_MAX_ENTRIES)
      .forEach((key) => delete all[key]);
  }
  try {
    store.setItem(LEARNED_HEIGHT_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 保存できなくても今回の被写体配置には影響させない。
  }
}

/**
 * 屋根/OSMで得た頂上点を登録座標へ固定する。高さ（楕円体高）はそのまま、
 * ジオイド高は登録座標で解決済みの地表点の値を使う（数十m内でのN差はmm級）。
 */
export function anchorToRegisteredCoordinates(
  resolvedTop: GroundPoint,
  groundPointAtAnchor: GroundPoint
): GroundPoint {
  if (resolvedTop.latitude === groundPointAtAnchor.latitude &&
    resolvedTop.longitude === groundPointAtAnchor.longitude) return resolvedTop;
  const ellipsoidal = ellipsoidalHeightMeters(resolvedTop);
  const geoid = groundPointAtAnchor.geoidHeightMeters;
  const orthometric = Number.isFinite(geoid)
    ? ellipsoidal - (geoid as number)
    : orthometricHeightMeters(resolvedTop);
  return {
    ...resolvedTop,
    latitude: groundPointAtAnchor.latitude,
    longitude: groundPointAtAnchor.longitude,
    height: ellipsoidal,
    ellipsoidalHeightMeters: ellipsoidal,
    orthometricHeightMeters: orthometric,
    geoidHeightMeters: Number.isFinite(geoid) ? geoid : resolvedTop.geoidHeightMeters,
  };
}

/**
 * 高さを確定できなかった登録スポットの仮配置。subjectSurfaceTargetを付けない
 * ため、履歴から選び直すと自動的に屋上の再解決が走る。
 */
export function provisionalRegisteredStructurePoint(groundPointAtAnchor: GroundPoint): GroundPoint {
  return {
    ...groundPointAtAnchor,
    subjectSurfaceTarget: undefined,
    structureHeightMeters: undefined,
    subjectHeightProvisional: true,
  };
}

/**
 * PLATEAU・OSMの両方で頂上高度を確定できなかった登録スポットの最終解決。
 * 学習済み高さがあればそれを使い、無ければ仮配置にする（例外を投げない）。
 */
export function resolveRegisteredStructureWithoutLiveHeight(
  anchor: RegisteredStructureAnchor,
  groundPointAtAnchor: GroundPoint,
  label: string
): GroundPoint {
  const learnedHeightMeters = readLearnedStructureHeight(anchor);
  if (learnedHeightMeters !== null) {
    return {
      ...selectSubjectSurfacePoint({
        groundPoint: groundPointAtAnchor,
        roofPoint: null,
        osmPoint: null,
        requireStructureRoof: true,
        knownStructureHeightMeters: learnedHeightMeters,
        label,
      }),
      heightSource: "learned-structure-height",
    };
  }
  return provisionalRegisteredStructurePoint(groundPointAtAnchor);
}
