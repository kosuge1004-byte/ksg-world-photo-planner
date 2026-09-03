export type RefractionCorrectionMode = "auto" | "standard";
export type AccuracyMode = "standard" | "highest";

export type PrecisionSettings = {
  /** 精度モードは従量制のGoogle/Cesium 3Dデータ利用だけを切り替える。無料の計算・DEM・気象補正は両モード共通。 */
  accuracyMode: AccuracyMode;
  refractionCorrectionMode: RefractionCorrectionMode;
  /** 三脚候補の本計算後に旧来の全距離探索を独立実行し、結果を検算する。 */
  tripodCandidateDoubleCheckEnabled: boolean;
  /**
   * 2026-09-02追記（明示指示により）: 三脚候補の初回探索（距離ヒントが
   * 無い状態）で対象とする最大距離。既定は10kmに絞り、探索が触れる
   * 地形タイルの範囲を狭めて速度を優先する。最大50km（従来の絶対上限）
   * まで設定画面から広げられる。距離ヒントがある再探索（時刻操作後の
   * 微調整等）には影響しない。
   */
  tripodSearchMaxDistanceMeters: number;
  /**
   * 2026-09-02追記（明示指示により）: 地形タイルの陰影計算用データ
   * （法線情報）を要求するかどうか。既定はOFF（要求しない）にして
   * 1タイルあたりの転送量を減らす。ONにすると地形の陰影表現が戻る
   * 代わりに通信量が増える。
   */
  terrainShadingEnabled: boolean;
};

export const TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS = 10_000;
export const TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS = 50_000;

export const DEFAULT_PRECISION_SETTINGS: PrecisionSettings = {
  accuracyMode: "highest",
  refractionCorrectionMode: "auto",
  tripodCandidateDoubleCheckEnabled: false,
  tripodSearchMaxDistanceMeters: TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS,
  terrainShadingEnabled: false,
};

export const REFRACTION_MODE_LABELS: Record<RefractionCorrectionMode, string> = {
  auto: "自動",
  standard: "標準大気",
};
