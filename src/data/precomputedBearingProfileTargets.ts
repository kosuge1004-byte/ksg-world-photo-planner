import { JAPAN_LANDMARKS } from "./japanLandmarks";

export type PrecomputedBearingProfileTarget = {
  name: string;
  latitude: number;
  longitude: number;
  maxDistanceMeters: number;
};

export const REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS = 10_000;
export const MOUNT_FUJI_PROFILE_DISTANCE_METERS = 100_000;

/**
 * R2へ配置する360方位プロファイルの正本。
 * 山岳は富士山だけ、それ以外の登録スポットは全件を対象にする。
 * 富士山だけは遠距離撮影に対応するため100 km、他地点は10 kmとする。
 * ランドマーク追加時に別の固定配列を更新し忘れないよう、検索カタログから導出する。
 */
export const PRECOMPUTED_BEARING_PROFILE_TARGETS: readonly PrecomputedBearingProfileTarget[] =
  JAPAN_LANDMARKS
    .filter((landmark) => landmark.category !== "mountain" || landmark.name === "富士山")
    .map(({ name, latitude, longitude }) => ({
      name,
      latitude,
      longitude,
      maxDistanceMeters: name === "富士山"
        ? MOUNT_FUJI_PROFILE_DISTANCE_METERS
        : REGISTERED_PROFILE_DEFAULT_DISTANCE_METERS,
    }));

export function findPrecomputedBearingProfileTarget(
  latitude: number,
  longitude: number
): PrecomputedBearingProfileTarget | null {
  return PRECOMPUTED_BEARING_PROFILE_TARGETS.find((landmark) =>
    Math.abs(landmark.latitude - latitude) <= 0.0000001 &&
    Math.abs(landmark.longitude - longitude) <= 0.0000001
  ) ?? null;
}

/** 一般設定を維持しつつ、富士山の登録座標だけ必要な100kmへ広げる。 */
export function registeredProfileCoverageDistanceMeters(
  latitude: number,
  longitude: number,
  requestedDistanceMeters: number
): number {
  const target = findPrecomputedBearingProfileTarget(latitude, longitude);
  return Math.max(requestedDistanceMeters, target?.maxDistanceMeters ?? 0);
}
