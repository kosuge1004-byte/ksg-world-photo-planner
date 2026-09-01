import type { Cartesian3, Scene } from "cesium";

/**
 * scene.clampToHeightMostDetailed はCesium独自の3Dタイルピック処理で、
 * 内部のタイル取得がdiagnosticFetch（全通信共通の8秒×3回timeout）を
 * 経由しない。回線が不安定で3Dタイルの取得が止まると、このPromiseは
 * 何分待っても解決/棄却されず、呼び出し元ごと無期限にハングする
 * （例: スポット検索の被写体解決が0%表示のまま固まる不具合）。
 *
 * 他の全通信と同じ「短いtimeoutで諦めてフォールバックする」方針に
 * 合わせ、この関数経由でだけ呼び出す。タイムアウト時は例外を投げるので、
 * 呼び出し側は既存のtry/catchで「取得できなかった」場合と同じに扱い、
 * 通常のDEM地面高等へフォールバックすること（0m等の代替値へは
 * 置き換えない）。
 */
const CLAMP_TO_HEIGHT_TIMEOUT_MS = 10_000;

type ClampToHeightMostDetailedScene = Pick<Scene, "clampToHeightMostDetailed">;

export async function clampToHeightWithTimeout(
  scene: ClampToHeightMostDetailedScene,
  cartesians: Cartesian3[],
  objectsToExclude?: unknown[],
  surfaceOffset?: number
): Promise<(Cartesian3 | undefined)[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("3Dタイルの表面取得がタイムアウトしました"));
    }, CLAMP_TO_HEIGHT_TIMEOUT_MS);
    scene
      .clampToHeightMostDetailed(cartesians, objectsToExclude as object[] | undefined, surfaceOffset)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}
