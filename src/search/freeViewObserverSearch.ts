/**
 * 自由ビューモードの「視点の位置」検索（2026-10-09）。
 *
 * 検索そのものは既存の経路（fetchSpotCandidates / resolveSpotLocation）を使う。
 * ここで決めるのは被写体ではなく「立つ場所」なので、検索結果が塔・建物の名称でも
 * 頂上へは置かず、その座標の地表（DEM＋ジオイド）を視点の地面とする。
 * 通常画面の三脚ピン・被写体ピン・履歴・内蔵スポットの登録は一切変更しない。
 */
import type { GroundPoint } from "../types/points";
import { resolveGroundPoint } from "../height/heightResolver";
import { resolveSpotLocation, type ResolvedSpotLocation } from "./spotPresetSearch";
import { isDirectLocationQuery } from "./placeCandidates";

export type FreeViewObserverLocation = Pick<ResolvedSpotLocation, "latitude" | "longitude" | "label">;

/** 「35.3606, 138.7274」形式の座標入力。該当しなければ null。 */
export function parseFreeViewCoordinateQuery(query: string): FreeViewObserverLocation | null {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,、]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/u
    .exec(query.normalize("NFKC"));
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude, label: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` };
}

/**
 * 座標・Googleマップ共有URLなど、候補一覧を出さずに1件へ決まる入力を解決する。
 * 座標は通信せずに読み取り、それ以外は既存の resolveSpotLocation に任せる。
 */
export async function resolveFreeViewDirectLocation(
  query: string,
  signal: AbortSignal,
  resolveLocation: typeof resolveSpotLocation = resolveSpotLocation
): Promise<FreeViewObserverLocation> {
  const coordinates = parseFreeViewCoordinateQuery(query);
  if (coordinates) return coordinates;
  const location = await resolveLocation(query, signal);
  return { latitude: location.latitude, longitude: location.longitude, label: location.label };
}

export { isDirectLocationQuery };

/**
 * 検索で決めた地点を、視点の地面（GroundPoint）にする。
 * 高さは現行の resolveGroundPoint（DEM/ジオイド）だけで求める。取得できなければ
 * 例外のまま返し、高さ0mで視点を確定しない（呼び出し側が未取得を表示して再試行を出す）。
 */
export async function resolveFreeViewObserverGround(
  location: FreeViewObserverLocation,
  resolveGround: typeof resolveGroundPoint = resolveGroundPoint
): Promise<GroundPoint> {
  const label = location.label?.trim() || "自由ビューの視点";
  const ground = await resolveGround(location.latitude, location.longitude, label);
  return { ...ground, label };
}

/**
 * 連続検索の後着対策。begin() が返す世代だけが「最新」で、古い世代の結果は
 * isCurrent() が false を返すので捨てる。begin() は前の検索を中止する。
 */
export function createLatestOnlyGuard(): {
  begin(): { signal: AbortSignal; isCurrent(): boolean };
  cancel(): void;
} {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const mine = ++generation;
      const current = controller;
      return {
        signal: current.signal,
        isCurrent: () => mine === generation && !current.signal.aborted,
      };
    },
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}
