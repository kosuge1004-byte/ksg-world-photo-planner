import type { CelestialScreenPoint, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { clearDeviceCacheNamespace, type DeviceCachePolicy } from "../cache/deviceCache";

/**
 * 2026-08-29修正（利用者からの明確な指示により無効化）: この端末永続
 * seedキャッシュ（IndexedDB）は、PCとスマートフォンなど複数端末で同じ
 * プロジェクトを開いた際に、端末ごとに独立した検索履歴を持つことになり、
 * 「同じプロジェクトなのに端末によって三脚候補の結果が違う」という
 * 問題の確認済みの原因だった。15件目でこの自己強化問題自体は一度
 * 修正したが、「一度でも誤った答えが確定すると、その端末にだけ保存され、
 * 以後その端末の検索を偏らせ続ける」という構造自体は温存されていた。
 * 度重なる調査でも「記憶をリセットすれば直る」という保証が得られな
 * かったため、この永続キャッシュそのものを無効化する。
 *
 * loadPersistentTripodSeeds()は常に空を返し、savePersistentTripodSeeds()
 * は何も保存しない。これにより、三脚候補探索は常にその場の入力
 * （被写体・日時・カメラ設定・地形データ）だけに基づいて行われ、端末や
 * 過去の検索履歴に左右されなくなる（探索が毎回ゼロから全距離を洗い直す
 * ため、体感速度は多少落ちうるが、結果の一貫性を優先する）。
 * clearPersistentTripodSeeds()は、無効化前に既に保存されていた可能性の
 * あるデータを一括削除するために残す。
 */
const POLICY: DeviceCachePolicy = {
  namespace: "tripod-candidate-seed-v1",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 512,
  memoryEntries: 128,
};

export type PersistentTripodSeed = {
  distanceMeters: number;
  latitude: number;
  longitude: number;
  height: number;
  savedAt: number;
};

export async function loadPersistentTripodSeeds(
  _subject: GroundPoint,
  _points: CelestialScreenPoint[]
): Promise<Partial<Record<CelestialScreenPoint["id"], PersistentTripodSeed>>> {
  // 無効化済み: 常に空を返す（詳細は本ファイル冒頭のコメント参照）。
  return {};
}

export async function savePersistentTripodSeeds(
  _subject: GroundPoint,
  _points: CelestialScreenPoint[],
  _candidates: TripodCandidate[]
): Promise<void> {
  // 無効化済み: 何も保存しない（詳細は本ファイル冒頭のコメント参照）。
  return;
}

/**
 * 無効化前に既に端末へ保存されていた可能性のあるデータを一括削除する。
 * 「三脚候補の記憶をリセット」ボタンから引き続き呼び出される。
 */
export async function clearPersistentTripodSeeds(): Promise<void> {
  await clearDeviceCacheNamespace(POLICY.namespace);
}
