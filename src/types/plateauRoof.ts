export type PlateauRoofCandidate = {
  dataset: string;
  year: number | null;
  buildingId: string;
  lod: 2 | 3 | 4;
  latitude: number;
  longitude: number;
  orthometricHeightMeters: number;
  buildingMinHeightMeters: number;
  buildingMaxHeightMeters: number;
  installationMaxHeightMeters: number | null;
  measuredHeightMeters: number | null;
  badCoordinatePolygons: number;
};

export type PlateauRoofLookupResponse = {
  candidate: PlateauRoofCandidate | null;
};

export function isPlateauRoofCandidate(value: unknown): value is PlateauRoofCandidate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PlateauRoofCandidate>;
  return typeof candidate.dataset === "string" && candidate.dataset.length > 0 &&
    typeof candidate.buildingId === "string" && candidate.buildingId.length > 0 &&
    (candidate.year === null || Number.isInteger(candidate.year)) &&
    (candidate.lod === 2 || candidate.lod === 3 || candidate.lod === 4) &&
    typeof candidate.latitude === "number" && Number.isFinite(candidate.latitude) &&
    typeof candidate.longitude === "number" && Number.isFinite(candidate.longitude) &&
    typeof candidate.orthometricHeightMeters === "number" && Number.isFinite(candidate.orthometricHeightMeters) &&
    typeof candidate.buildingMinHeightMeters === "number" && Number.isFinite(candidate.buildingMinHeightMeters) &&
    typeof candidate.buildingMaxHeightMeters === "number" && Number.isFinite(candidate.buildingMaxHeightMeters) &&
    (candidate.installationMaxHeightMeters === null ||
      (typeof candidate.installationMaxHeightMeters === "number" && Number.isFinite(candidate.installationMaxHeightMeters))) &&
    (candidate.measuredHeightMeters === null ||
      (typeof candidate.measuredHeightMeters === "number" && Number.isFinite(candidate.measuredHeightMeters))) &&
    Number.isSafeInteger(candidate.badCoordinatePolygons) &&
    (candidate.badCoordinatePolygons as number) >= 0;
}

export function isPlateauRoofLookupResponse(value: unknown): value is PlateauRoofLookupResponse {
  if (typeof value !== "object" || value === null || !("candidate" in value)) return false;
  return value.candidate === null || isPlateauRoofCandidate(value.candidate);
}
