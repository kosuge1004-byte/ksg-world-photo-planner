import type { TripodCandidate } from "../types/celestial";
import { getDeviceCache, getDeviceCacheMany, setDeviceCache, clearDeviceCacheNamespace } from "./deviceCache";

/**
 * 2026-09-04追記: お気に入り登録した被写体について、日の出没・月の出没
 * ごとの三脚候補（精密計算の最終結果そのもの）を端末（IndexedDB）へ
 * 事前保存しておく「ローリングウィンドウ」キャッシュ。
 *
 * 設計上の要点（会話で詰めた内容の反映）:
 * - 保存するのは生の地形タイルではなく、サーバーの正規経路でフル計算
 *   させた「最終結果（答えそのもの）」。端末側での再解釈・再補間は
 *   一切行わない（＝過去に実機で問題になった「距離ヒントで探索範囲を
 *   狭める」系の失敗モードとは無関係）。
 * - 焦点距離はこの候補位置の計算に使われていない（tripodCandidates.ts
 *   のtrace文字列にしか出てこない）ため、キャッシュキーに含めない。
 *   キーに含めるのはカメラ高のみ（丸め誤差対策で1cm単位に丸める）。
 * - 「ローリング」なので、日付そのもの・有効期限どちらでも自然に
 *   古いものが失効する。明示的なprune処理はマネージャー側で行う。
 */

const NAMESPACE_PREFIX = "tripod-rolling-window-v1";
// ウィンドウの運用上限より少し長めに持たせておき、ウィンドウを後から
// 広げた場合でも既存データを無駄に失効させない。実際の「表示対象からの
// 除外」はマネージャー側のウィンドウ計算（日付ベース）で行う。
const ENTRY_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export type RollingWindowEventKey = "sunrise" | "sunset" | "moonrise" | "moonset";

export type RollingWindowEntry = {
  /** そのイベント（日の出没・月の出没）の正確な日時（ISO文字列）。 */
  eventTimeIso: string;
  /** その日時に見つかった三脚候補（0件の場合もそのまま保存し、再計算を避ける）。 */
  candidates: TripodCandidate[];
  /** キャッシュを作った時刻（診断・表示用）。 */
  computedAtIso: string;
};

/** カメラ高をキーに使う際、浮動小数の誤差で別キー扱いにならないよう1cm単位に丸める。 */
export function roundCameraHeightForCacheKey(lensCenterHeightMeters: number): number {
  return Math.round(lensCenterHeightMeters * 100) / 100;
}

// 被写体ごとに独立した名前空間にしておくことで、後で「このお気に入りの
// キャッシュだけ消す」（clearRollingWindowCacheForSubject）が、他の
// お気に入りに影響せず安全に行える。
function namespaceFor(subjectId: string): string {
  return `${NAMESPACE_PREFIX}:${subjectId}`;
}

function cacheKey(
  cameraHeightMeters: number,
  dateText: string,
  eventKey: RollingWindowEventKey
): string {
  return `${roundCameraHeightForCacheKey(cameraHeightMeters)}:${dateText}:${eventKey}`;
}

export async function getRollingWindowEntry(
  subjectId: string,
  cameraHeightMeters: number,
  dateText: string,
  eventKey: RollingWindowEventKey
): Promise<RollingWindowEntry | null> {
  return getDeviceCache<RollingWindowEntry>(
    { namespace: namespaceFor(subjectId), ttlMs: ENTRY_TTL_MS, maxEntries: 3_000 },
    cacheKey(cameraHeightMeters, dateText, eventKey)
  );
}

/** 1日ぶん（sunrise/sunset/moonrise/moonset）を1回のIndexedDBトランザクションでまとめて読む。 */
export async function getRollingWindowDay(
  subjectId: string,
  cameraHeightMeters: number,
  dateText: string
): Promise<Record<RollingWindowEventKey, RollingWindowEntry | null>> {
  const eventKeys: RollingWindowEventKey[] = ["sunrise", "sunset", "moonrise", "moonset"];
  const results = await getDeviceCacheMany<RollingWindowEntry>(
    { namespace: namespaceFor(subjectId), ttlMs: ENTRY_TTL_MS, maxEntries: 3_000 },
    eventKeys.map((eventKey) => cacheKey(cameraHeightMeters, dateText, eventKey))
  );
  return {
    sunrise: results[0],
    sunset: results[1],
    moonrise: results[2],
    moonset: results[3],
  };
}

export async function setRollingWindowEntry(
  subjectId: string,
  cameraHeightMeters: number,
  dateText: string,
  eventKey: RollingWindowEventKey,
  entry: RollingWindowEntry
): Promise<void> {
  await setDeviceCache(
    { namespace: namespaceFor(subjectId), ttlMs: ENTRY_TTL_MS, maxEntries: 3_000 },
    cacheKey(cameraHeightMeters, dateText, eventKey),
    entry
  );
}

/** お気に入り解除時などに、その被写体ぶんのローリングウィンドウキャッシュだけを削除する。 */
export async function clearRollingWindowCacheForSubject(subjectId: string): Promise<void> {
  await clearDeviceCacheNamespace(namespaceFor(subjectId));
}

