import { JAPAN_LANDMARKS } from "./japanLandmarks";

export type PrecomputedBearingProfileTarget = {
  name: string;
  latitude: number;
  longitude: number;
};

/**
 * R2へ配置する10 km・360方位プロファイルの正本。
 * 山岳は富士山だけ、それ以外の登録スポットは全件を対象にする。
 * ランドマーク追加時に別の固定配列を更新し忘れないよう、検索カタログから導出する。
 */
export const PRECOMPUTED_BEARING_PROFILE_TARGETS: readonly PrecomputedBearingProfileTarget[] =
  JAPAN_LANDMARKS
    .filter((landmark) => landmark.category !== "mountain" || landmark.name === "富士山")
    .map(({ name, latitude, longitude }) => ({ name, latitude, longitude }));

export function findPrecomputedBearingProfileTarget(
  latitude: number,
  longitude: number
): PrecomputedBearingProfileTarget | null {
  return PRECOMPUTED_BEARING_PROFILE_TARGETS.find((landmark) =>
    Math.abs(landmark.latitude - latitude) <= 0.0000001 &&
    Math.abs(landmark.longitude - longitude) <= 0.0000001
  ) ?? null;
}
