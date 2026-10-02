export const DYNAMIC_SPOT_SCHEMA_VERSION = 1 as const;
export const DYNAMIC_SPOT_PROFILE_VERSION = "bearing-profile-v1-10km-360" as const;
export const DYNAMIC_SPOT_MAX_DISTANCE_METERS = 10_000;
export const DYNAMIC_SPOT_BEARING_COUNT = 360;

export type DynamicSpotSubjectSurface = "terrain" | "structure";
export type DynamicSpotHeightSourceType =
  | "official"
  | "plateau-measured"
  | "osm-height"
  | "osm-levels-estimate"
  | "unknown";
export type DynamicSpotHeightStatus = "verified" | "measured" | "estimated" | "unknown";
export type DynamicSpotDemProfileStatus = "pending" | "partial" | "complete" | "failed";

export type DynamicSpotRecord = {
  schemaVersion: typeof DYNAMIC_SPOT_SCHEMA_VERSION;
  id: string;
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
  category: string;
  subjectSurface: DynamicSpotSubjectSurface;
  structureHeightMeters: number | null;
  heightSourceType: DynamicSpotHeightSourceType;
  heightSourceUrl: string | null;
  heightSourceLabel: string | null;
  heightStatus: DynamicSpotHeightStatus;
  demProfileStatus: DynamicSpotDemProfileStatus;
  maxDistanceMeters: number;
  bearingCount: number;
  createdAt: string;
  updatedAt: string;
  coordinateKey: string;
  profileVersion: string;
  completedBearings?: number;
  failedBearings?: number;
  currentStage?: "waiting" | "terrain" | "validating" | "complete" | "failed";
  generationStartedAt?: string | null;
  generationElapsedMs?: number;
  lastError?: string | null;
  profileBytes?: number;
  profileSha256?: string | null;
};

export type DynamicSpotRegistrationInput = Pick<
  DynamicSpotRecord,
  | "name"
  | "aliases"
  | "latitude"
  | "longitude"
  | "category"
  | "subjectSurface"
  | "structureHeightMeters"
  | "heightSourceType"
  | "heightSourceUrl"
  | "heightSourceLabel"
  | "heightStatus"
> & {
  maxDistanceMeters?: number;
  bearingCount?: number;
};

export function dynamicSpotCoordinateKey(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Dynamic Spotの座標が不正です");
  }
  // Dynamic coordinates use eight decimals (roughly millimetre scale in
  // Japan). A nearby search point must never inherit another spot's profile.
  return `${latitude.toFixed(8)},${longitude.toFixed(8)}`;
}

export function normalizeDynamicSpotSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("ja");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && Number.isFinite(Date.parse(value));
}

export function isDynamicSpotRecord(value: unknown): value is DynamicSpotRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const sourceTypes = new Set<DynamicSpotHeightSourceType>([
    "official", "plateau-measured", "osm-height", "osm-levels-estimate", "unknown",
  ]);
  const heightStatuses = new Set<DynamicSpotHeightStatus>([
    "verified", "measured", "estimated", "unknown",
  ]);
  const profileStatuses = new Set<DynamicSpotDemProfileStatus>([
    "pending", "partial", "complete", "failed",
  ]);
  if (
    record.schemaVersion !== DYNAMIC_SPOT_SCHEMA_VERSION ||
    typeof record.id !== "string" || !/^dynamic-[a-f0-9]{32}$/.test(record.id) ||
    typeof record.name !== "string" || record.name.trim().length < 1 || record.name.length > 200 ||
    !Array.isArray(record.aliases) || record.aliases.length > 20 ||
    record.aliases.some((alias) => typeof alias !== "string" || alias.length > 200) ||
    !finiteNumber(record.latitude) || record.latitude < 20 || record.latitude > 46.5 ||
    !finiteNumber(record.longitude) || record.longitude < 122 || record.longitude > 154 ||
    typeof record.category !== "string" || record.category.length > 100 ||
    (record.subjectSurface !== "terrain" && record.subjectSurface !== "structure") ||
    !sourceTypes.has(record.heightSourceType as DynamicSpotHeightSourceType) ||
    !heightStatuses.has(record.heightStatus as DynamicSpotHeightStatus) ||
    !profileStatuses.has(record.demProfileStatus as DynamicSpotDemProfileStatus) ||
    record.maxDistanceMeters !== DYNAMIC_SPOT_MAX_DISTANCE_METERS ||
    record.bearingCount !== DYNAMIC_SPOT_BEARING_COUNT ||
    !validIso(record.createdAt) || !validIso(record.updatedAt) ||
    record.coordinateKey !== dynamicSpotCoordinateKey(record.latitude, record.longitude) ||
    record.profileVersion !== DYNAMIC_SPOT_PROFILE_VERSION
  ) return false;
  if (record.heightSourceUrl !== null && typeof record.heightSourceUrl !== "string") return false;
  if (record.heightSourceLabel !== null && typeof record.heightSourceLabel !== "string") return false;
  if (record.subjectSurface === "terrain") {
    if (record.structureHeightMeters !== 0) return false;
  } else if (
    record.structureHeightMeters !== null &&
    (!finiteNumber(record.structureHeightMeters) || record.structureHeightMeters < 1.5 ||
      record.structureHeightMeters > 1_000)
  ) return false;
  if (record.demProfileStatus === "complete") {
    if (record.completedBearings !== DYNAMIC_SPOT_BEARING_COUNT) return false;
    if (record.subjectSurface === "structure" && !finiteNumber(record.structureHeightMeters)) return false;
    if (record.subjectSurface === "structure" &&
      (record.heightSourceType === "unknown" || record.heightStatus === "unknown")) return false;
    if (typeof record.profileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.profileSha256)) {
      return false;
    }
  }
  return true;
}

export function isDynamicSpotRegistrationInput(value: unknown): value is DynamicSpotRegistrationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "name", "aliases", "latitude", "longitude", "category", "subjectSurface",
    "structureHeightMeters", "heightSourceType", "heightSourceUrl", "heightSourceLabel",
    "heightStatus", "maxDistanceMeters", "bearingCount",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return false;
  if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 200) return false;
  if (!Array.isArray(input.aliases) || input.aliases.length > 20 ||
    input.aliases.some((alias) => typeof alias !== "string" || alias.length > 200)) return false;
  if (!finiteNumber(input.latitude) || input.latitude < 20 || input.latitude > 46.5 ||
    !finiteNumber(input.longitude) || input.longitude < 122 || input.longitude > 154) return false;
  if (typeof input.category !== "string" || input.category.length > 100) return false;
  if (input.subjectSurface !== "terrain" && input.subjectSurface !== "structure") return false;
  if (input.heightSourceUrl !== null && typeof input.heightSourceUrl !== "string") return false;
  if (input.heightSourceLabel !== null && typeof input.heightSourceLabel !== "string") return false;
  if (!["official", "plateau-measured", "osm-height", "osm-levels-estimate", "unknown"]
    .includes(String(input.heightSourceType))) return false;
  if (!["verified", "measured", "estimated", "unknown"].includes(String(input.heightStatus))) return false;
  if (input.maxDistanceMeters !== undefined && input.maxDistanceMeters !== DYNAMIC_SPOT_MAX_DISTANCE_METERS) return false;
  if (input.bearingCount !== undefined && input.bearingCount !== DYNAMIC_SPOT_BEARING_COUNT) return false;
  if (input.subjectSurface === "terrain") {
    return input.structureHeightMeters === 0;
  }
  return input.structureHeightMeters === null ||
    (finiteNumber(input.structureHeightMeters) && input.structureHeightMeters >= 1.5 &&
      input.structureHeightMeters <= 1_000);
}
