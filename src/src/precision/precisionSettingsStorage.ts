import {
  DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS,
  DEFAULT_PRECISION_SETTINGS,
  DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS,
  type PrecisionSettings,
} from "../types/precision";

export const PRECISION_SETTINGS_STORAGE_KEY = "ksg-precision-settings";

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue)
    ? Math.min(maximum, Math.max(minimum, parsedValue))
    : fallback;
}

export function normalizePrecisionSettings(value: unknown): PrecisionSettings {
  if (!value || typeof value !== "object") return DEFAULT_PRECISION_SETTINGS;
  const parsed = value as Partial<PrecisionSettings>;
  const refractionCorrectionMode = parsed.refractionCorrectionMode;
  if (
    refractionCorrectionMode !== "auto" &&
    refractionCorrectionMode !== "standard" &&
    refractionCorrectionMode !== "none"
  ) {
    return DEFAULT_PRECISION_SETTINGS;
  }

  const storedExclusion = parsed.subjectObstructionExclusionMeters;
  const legacyValue = typeof storedExclusion === "number" ? storedExclusion : undefined;
  const storedObject = storedExclusion && typeof storedExclusion === "object"
    ? storedExclusion as Partial<typeof DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS>
    : {};

  const storedBuildingDetail = parsed.buildingOcclusionDetailSettings;
  const storedBuildingDetailObject = storedBuildingDetail && typeof storedBuildingDetail === "object"
    ? storedBuildingDetail as Partial<typeof DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS>
    : {};
  const edgeSampleCount = storedBuildingDetailObject.edgeSampleCount;

  return {
    accuracyMode: parsed.accuracyMode === "highest" ? "highest" : "standard",
    refractionCorrectionMode,
    subjectObstructionExclusionMeters: {
      under100m: clamp(storedObject.under100m ?? legacyValue, DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS.under100m, 0, 500),
      from100mTo500m: clamp(storedObject.from100mTo500m ?? legacyValue, DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS.from100mTo500m, 0, 500),
      from500mTo2km: clamp(storedObject.from500mTo2km ?? legacyValue, DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS.from500mTo2km, 0, 500),
      over2km: clamp(storedObject.over2km ?? legacyValue, DEFAULT_SUBJECT_OBSTRUCTION_EXCLUSION_METERS.over2km, 0, 500),
    },
    buildingOcclusionDetailSettings: {
      detailedEdgeCheckEnabled: storedBuildingDetailObject.detailedEdgeCheckEnabled === true,
      edgeSampleCount: edgeSampleCount === 4 || edgeSampleCount === 8 || edgeSampleCount === 12
        ? edgeSampleCount
        : DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS.edgeSampleCount,
      obstructedThresholdPercent: clamp(
        storedBuildingDetailObject.obstructedThresholdPercent,
        DEFAULT_BUILDING_OCCLUSION_DETAIL_SETTINGS.obstructedThresholdPercent,
        0,
        100
      ),
    },
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
