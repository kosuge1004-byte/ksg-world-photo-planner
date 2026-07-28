export type RefractionCorrectionMode = "auto" | "standard" | "none";

export type SubjectObstructionExclusionSettings = {
  under100m: number;
  from100mTo500m: number;
  from500mTo2km: number;
  over2km: number;
};

export type BuildingOcclusionEdgeSampleCount = 4 | 8 | 12;

/** ②建物3D遮蔽の詳細判定（太陽・月の視直径を考慮した縁サンプリング）の設定。 */
export type BuildingOcclusionDetailSettings = {
  /** false の場合、従来どおり天体中心1点だけを判定する。 */
  detailedEdgeCheckEnabled: boolean;
  /** 中心に加えて円盤の縁をいくつの点でサンプリングするか。 */
  edgeSampleCount: BuildingOcclusionEdgeSampleCount;
  /** サンプル点のうち遮蔽された割合がこの値（%）以上で「遮蔽物あり」と判定する。 */
  obstructedThresholdPercent: number;
};

export const DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS: BuildingOcclusionDetailSettings = {
  detailedEdgeCheckEnabled: false,
  edgeSampleCount: 8,
  obstructedThresholdPercent: 50,
};

export type PrecisionSettings = {
  refractionCorrectionMode: RefractionCorrectionMode;
  /** 被写体までの距離帯ごとに、被写体ピン手前で遮蔽物判定から除外する距離（m）。 */
  subjectObstructionExclusionMeters: SubjectObstructionExclusionSettings;
  /** ②建物3D遮蔽の詳細判定設定。 */
  buildingOcclusionDetailSettings: BuildingOcclusionDetailSettings;
};

export const DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS: SubjectObstructionExclusionSettings = {
  under100m: 3,
  from100mTo500m: 10,
  from500mTo2km: 20,
  over2km: 50,
};

export const DEFAULT_PRECISION_SETTINGS: PrecisionSettings = {
  refractionCorrectionMode: "auto",
  subjectObstructionExclusionMeters: DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS,
  buildingOcclusionDetailSettings: DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS,
};

export function selectSubjectObstructionExclusionMeters(
  subjectDistanceMeters: number,
  settings: SubjectObstructionExclusionSettings
): number {
  if (subjectDistanceMeters < 100) return settings.under100m;
  if (subjectDistanceMeters < 500) return settings.from100mTo500m;
  if (subjectDistanceMeters < 2_000) return settings.from500mTo2km;
  return settings.over2km;
}

export const REFRACTION_MODE_LABELS: Record<RefractionCorrectionMode, string> = {
  auto: "自動",
  standard: "標準大気",
  none: "補正なし",
};
