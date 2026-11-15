import type { CelestialBodyId } from "./celestial";
import {
  isPlateauBuildingReference,
  type PlateauBuildingReference,
} from "./plateauRoof";

export const CANDIDATE_POINT_VISIBILITY_MAX_POINTS = 64;

export type CandidatePointVisibilityRequestPoint = {
  key: string;
  celestialId: Extract<CelestialBodyId, "sun" | "moon" | "milkyWay">;
  timestampMilliseconds: number;
  latitude: number;
  longitude: number;
};

export type CandidatePointVisibilityRequest = {
  subject: {
    latitude: number;
    longitude: number;
    orthometricHeightMeters: number;
    plateauBuildingRef?: PlateauBuildingReference;
  };
  lensCenterHeightMeters: number;
  points: CandidatePointVisibilityRequestPoint[];
};

export type CandidateBuildingVisibilityStatus = "clear" | "blocked" | "unverified";

export type CandidatePointBuildingVisibility = {
  key: string;
  status: CandidateBuildingVisibilityStatus;
  obstructionDistanceMeters?: number;
  obstructionBuildingId?: string;
  dataset?: string;
};

export type CandidatePointVisibilityResponse = {
  results: CandidatePointBuildingVisibility[];
  excludedSubjectBuilding: PlateauBuildingReference | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function japanCoordinate(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) &&
    typeof longitude === "number" && Number.isFinite(longitude) &&
    latitude >= 20 && latitude <= 46.5 && longitude >= 122 && longitude <= 154;
}

export function isCandidatePointVisibilityRequest(
  value: unknown
): value is CandidatePointVisibilityRequest {
  const request = record(value);
  if (!request || Object.keys(request).some((key) =>
    key !== "subject" && key !== "lensCenterHeightMeters" && key !== "points")) return false;
  const subject = record(request.subject);
  if (!subject || Object.keys(subject).some((key) =>
    key !== "latitude" && key !== "longitude" && key !== "orthometricHeightMeters" &&
    key !== "plateauBuildingRef")) return false;
  if (!japanCoordinate(subject.latitude, subject.longitude) ||
    typeof subject.orthometricHeightMeters !== "number" ||
    !Number.isFinite(subject.orthometricHeightMeters) ||
    subject.orthometricHeightMeters < -500 || subject.orthometricHeightMeters > 12_000 ||
    (subject.plateauBuildingRef !== undefined &&
      !isPlateauBuildingReference(subject.plateauBuildingRef))) return false;
  if (typeof request.lensCenterHeightMeters !== "number" ||
    !Number.isFinite(request.lensCenterHeightMeters) ||
    request.lensCenterHeightMeters < 0.1 || request.lensCenterHeightMeters > 20) return false;
  if (!Array.isArray(request.points) || request.points.length < 1 ||
    request.points.length > CANDIDATE_POINT_VISIBILITY_MAX_POINTS) return false;
  const keys = new Set<string>();
  return request.points.every((entry) => {
    const point = record(entry);
    if (!point || Object.keys(point).some((key) =>
      key !== "key" && key !== "celestialId" && key !== "timestampMilliseconds" &&
      key !== "latitude" && key !== "longitude")) return false;
    if (typeof point.key !== "string" || point.key.length < 1 || point.key.length > 160 ||
      keys.has(point.key) || !/^[a-z0-9:._-]+$/iu.test(point.key)) return false;
    if (point.celestialId !== "sun" && point.celestialId !== "moon" &&
      point.celestialId !== "milkyWay") return false;
    if (typeof point.timestampMilliseconds !== "number" ||
      !Number.isSafeInteger(point.timestampMilliseconds) ||
      point.timestampMilliseconds < 0 || point.timestampMilliseconds > 8_640_000_000_000_000 ||
      !japanCoordinate(point.latitude, point.longitude)) return false;
    keys.add(point.key);
    return true;
  });
}

export function isCandidatePointVisibilityResponse(
  value: unknown,
  expectedKeys?: ReadonlySet<string>
): value is CandidatePointVisibilityResponse {
  const response = record(value);
  if (!response || Object.keys(response).some((key) =>
    key !== "results" && key !== "excludedSubjectBuilding") ||
    !Array.isArray(response.results) ||
    (response.excludedSubjectBuilding !== null &&
      !isPlateauBuildingReference(response.excludedSubjectBuilding))) return false;
  const keys = new Set<string>();
  const valid = response.results.every((entry) => {
    const result = record(entry);
    if (!result || Object.keys(result).some((key) =>
      key !== "key" && key !== "status" && key !== "obstructionDistanceMeters" &&
      key !== "obstructionBuildingId" && key !== "dataset")) return false;
    if (typeof result.key !== "string" || keys.has(result.key) ||
      (expectedKeys && !expectedKeys.has(result.key))) return false;
    if (result.status !== "clear" && result.status !== "blocked" &&
      result.status !== "unverified") return false;
    if (result.obstructionDistanceMeters !== undefined &&
      (typeof result.obstructionDistanceMeters !== "number" ||
        !Number.isFinite(result.obstructionDistanceMeters) || result.obstructionDistanceMeters < 0)) return false;
    if (result.obstructionBuildingId !== undefined &&
      (typeof result.obstructionBuildingId !== "string" || result.obstructionBuildingId.length > 300)) return false;
    if (result.dataset !== undefined &&
      (typeof result.dataset !== "string" || result.dataset.length > 300)) return false;
    keys.add(result.key);
    return true;
  });
  return valid && (!expectedKeys || keys.size === expectedKeys.size);
}
