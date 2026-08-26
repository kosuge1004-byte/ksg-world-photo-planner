export type RefractionCorrectionMode = "auto" | "standard";
export type AccuracyMode = "standard" | "highest";

export type PrecisionSettings = {
  /** 精度モードは従量制のGoogle/Cesium 3Dデータ利用だけを切り替える。無料の計算・DEM・気象補正は両モード共通。 */
  accuracyMode: AccuracyMode;
  refractionCorrectionMode: RefractionCorrectionMode;
  /** 三脚候補の本計算後に旧来の全距離探索を独立実行し、結果を検算する。 */
  tripodCandidateDoubleCheckEnabled: boolean;
};

export const DEFAULT_PRECISION_SETTINGS: PrecisionSettings = {
  accuracyMode: "highest",
  refractionCorrectionMode: "auto",
  tripodCandidateDoubleCheckEnabled: false,
};

export const REFRACTION_MODE_LABELS: Record<RefractionCorrectionMode, string> = {
  auto: "自動",
  standard: "標準大気",
};
