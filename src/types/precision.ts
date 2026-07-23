export type RefractionCorrectionMode = "auto" | "standard" | "none";

export type PrecisionSettings = {
  refractionCorrectionMode: RefractionCorrectionMode;
};

export const DEFAULT_PRECISION_SETTINGS: PrecisionSettings = {
  refractionCorrectionMode: "auto",
};

export const REFRACTION_MODE_LABELS: Record<RefractionCorrectionMode, string> = {
  auto: "自動",
  standard: "標準大気",
  none: "補正なし",
};
