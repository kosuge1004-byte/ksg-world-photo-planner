import {
  DEFAULT_PRECISION_SETTINGS,
  TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS,
  TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS,
  type PrecisionSettings,
} from "../types/precision";

export const PRECISION_SETTINGS_STORAGE_KEY = "ksg-precision-settings";

export function normalizePrecisionSettings(value: unknown): PrecisionSettings {
  if (!value || typeof value !== "object") return DEFAULT_PRECISION_SETTINGS;
  const parsed = value as Partial<PrecisionSettings>;
  // 「補正なし」は誤解を招く上、pro固定のメイン計算経路では実際には
  // 屈折を無効化できていなかったため廃止した。過去に保存された
  // "none"（旧設定）は、設定全体を初期化するのではなく、この項目だけ
  // 既定値（自動）へ静かに移行する。
  const refractionCorrectionMode = parsed.refractionCorrectionMode === "standard"
    ? "standard"
    : DEFAULT_PRECISION_SETTINGS.refractionCorrectionMode;

  return {
    accuracyMode: parsed.accuracyMode === "highest" ? "highest" : "standard",
    refractionCorrectionMode,
    tripodCandidateDoubleCheckEnabled: parsed.tripodCandidateDoubleCheckEnabled === true,
    tripodSearchMaxDistanceMeters:
      Number.isFinite(parsed.tripodSearchMaxDistanceMeters) &&
      (parsed.tripodSearchMaxDistanceMeters as number) > 0
        ? Math.min(
            TRIPOD_SEARCH_MAX_DISTANCE_ABSOLUTE_METERS,
            parsed.tripodSearchMaxDistanceMeters as number
          )
        : TRIPOD_SEARCH_MAX_DISTANCE_DEFAULT_METERS,
    terrainShadingEnabled: parsed.terrainShadingEnabled === true,
  };
}

export function loadPrecisionSettingsFromStorage(storage: Pick<Storage, "getItem"> = localStorage): PrecisionSettings {
  try {
    const saved = storage.getItem(PRECISION_SETTINGS_STORAGE_KEY);
    return saved ? normalizePrecisionSettings(JSON.parse(saved) as unknown) : DEFAULT_PRECISION_SETTINGS;
  } catch {
    return DEFAULT_PRECISION_SETTINGS;
  }
}

export function savePrecisionSettingsToStorage(
  settings: PrecisionSettings,
  storage: Pick<Storage, "setItem"> = localStorage
): void {
  storage.setItem(PRECISION_SETTINGS_STORAGE_KEY, JSON.stringify(normalizePrecisionSettings(settings)));
}
