import {
  calculateKarneyDestinationPoint,
  calculateKarneySurfaceMetrics,
} from "../../src/geodesy/karneyGeodesic.ts";
import { effectiveEarthRadiusMeters } from "../../src/geodesy/terrestrialRefraction.ts";

export type PlateauLineOfSightCoordinate = {
  latitude: number;
  longitude: number;
};

export type PlateauLineOfSightPathPoint = PlateauLineOfSightCoordinate & {
  fraction: number;
  distanceMeters: number;
};

export type PlateauLineOfSightFace = number[][];

export type PlateauLineOfSightGeometry = {
  minimumHeightMeters: number;
  maximumHeightMeters: number;
  topFaces: PlateauLineOfSightFace[];
};

export type PlateauLineOfSightBuilding = {
  dataset: string;
  buildingId: string;
  bbox: readonly [number, number, number, number];
  geometry: PlateauLineOfSightGeometry;
};

export type PlateauLineOfSightBlocker = {
  dataset: string;
  buildingId: string;
  distanceFromCandidateMeters: number;
};

const PATH_STEP_METERS = 50;
const ENDPOINT_EXCLUSION_METERS = 1;
const HEIGHT_TOLERANCE_METERS = 0.25;

function pointOnSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-11) return false;
  return (x - ax) * (x - bx) + (y - ay) * (y - by) <= 1e-14;
}

function insideRing(latitude: number, longitude: number, ring: readonly number[]): boolean {
  if (ring.length < 12 || ring.length % 3 !== 0) return false;
  let inside = false;
  const count = ring.length / 3;
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const yi = ring[index * 3];
    const xi = ring[index * 3 + 1];
    const yj = ring[previous * 3];
    const xj = ring[previous * 3 + 1];
    if (pointOnSegment(longitude, latitude, xi, yi, xj, yj)) return true;
    if ((yi > latitude) !== (yj > latitude) &&
      longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideFace(latitude: number, longitude: number, face: PlateauLineOfSightFace): boolean {
  return Array.isArray(face) && face.length > 0 && insideRing(latitude, longitude, face[0]) &&
    face.slice(1).every((hole) => !insideRing(latitude, longitude, hole));
}

function segmentIntersectionParameter(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): number | null {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const denominator = abx * cdy - aby * cdx;
  if (Math.abs(denominator) < 1e-15) return null;
  const acx = cx - ax;
  const acy = cy - ay;
  const t = (acx * cdy - acy * cdx) / denominator;
  const u = (acx * aby - acy * abx) / denominator;
  return t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10
    ? Math.max(0, Math.min(1, t))
    : null;
}

function insideIntervals(
  start: PlateauLineOfSightCoordinate,
  end: PlateauLineOfSightCoordinate,
  face: PlateauLineOfSightFace
): Array<[number, number]> {
  const parameters = [0, 1];
  for (const ring of face) {
    const count = ring.length / 3;
    for (let index = 0; index < count - 1; index += 1) {
      const intersection = segmentIntersectionParameter(
        start.longitude,
        start.latitude,
        end.longitude,
        end.latitude,
        ring[index * 3 + 1],
        ring[index * 3],
        ring[(index + 1) * 3 + 1],
        ring[(index + 1) * 3]
      );
      if (intersection !== null) parameters.push(intersection);
    }
  }
  parameters.sort((left, right) => left - right);
  const unique = parameters.filter((value, index) => index === 0 || value - parameters[index - 1] > 1e-9);
  const intervals: Array<[number, number]> = [];
  for (let index = 1; index < unique.length; index += 1) {
    const lower = unique[index - 1];
    const upper = unique[index];
    const middle = (lower + upper) / 2;
    const latitude = start.latitude + (end.latitude - start.latitude) * middle;
    const longitude = start.longitude + (end.longitude - start.longitude) * middle;
    if (insideFace(latitude, longitude, face)) intervals.push([lower, upper]);
  }
  return intervals;
}

function planeHeight(
  latitude: number,
  longitude: number,
  ring: readonly number[]
): number | null {
  if (ring.length < 9) return null;
  const lat0 = ring[0];
  const lon0 = ring[1];
  const z0 = ring[2];
  const cosine = Math.cos(lat0 * Math.PI / 180);
  const local = (offset: number) => ({
    x: (ring[offset + 1] - lon0) * cosine * 111_320,
    y: (ring[offset] - lat0) * 110_540,
    z: ring[offset + 2] - z0,
  });
  const first = local(3);
  for (let offset = 6; offset < ring.length; offset += 3) {
    const second = local(offset);
    const normal = {
      x: first.y * second.z - first.z * second.y,
      y: first.z * second.x - first.x * second.z,
      z: first.x * second.y - first.y * second.x,
    };
    if (Math.abs(normal.z) <= 1e-8) continue;
    const x = (longitude - lon0) * cosine * 111_320;
    const y = (latitude - lat0) * 110_540;
    const height = z0 - (normal.x * x + normal.y * y) / normal.z;
    return Number.isFinite(height) ? height : null;
  }
  return null;
}

/** 日本の3次地域メッシュ（8桁、約1km四方）。 */
export function japaneseThirdMeshCode(latitude: number, longitude: number): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < 20 || latitude > 46.5 || longitude < 122 || longitude > 154) return null;
  const latitudeUnit = latitude * 1.5;
  const longitudeUnit = longitude - 100;
  const firstLatitude = Math.floor(latitudeUnit);
  const firstLongitude = Math.floor(longitudeUnit);
  const latitudeSecondValue = (latitudeUnit - firstLatitude) * 8;
  const longitudeSecondValue = (longitudeUnit - firstLongitude) * 8;
  const secondLatitude = Math.floor(latitudeSecondValue);
  const secondLongitude = Math.floor(longitudeSecondValue);
  const thirdLatitude = Math.min(9, Math.floor((latitudeSecondValue - secondLatitude) * 10));
  const thirdLongitude = Math.min(9, Math.floor((longitudeSecondValue - secondLongitude) * 10));
  return `${String(firstLatitude).padStart(2, "0")}${String(firstLongitude).padStart(2, "0")}` +
    `${secondLatitude}${secondLongitude}${thirdLatitude}${thirdLongitude}`;
}

export function buildPlateauLineOfSightPath(
  candidate: PlateauLineOfSightCoordinate,
  subject: PlateauLineOfSightCoordinate,
  stepMeters = PATH_STEP_METERS
): { distanceMeters: number; points: PlateauLineOfSightPathPoint[] } {
  const metrics = calculateKarneySurfaceMetrics(candidate, subject);
  if (metrics.distanceMeters <= 0) return {
    distanceMeters: 0,
    points: [{ ...candidate, fraction: 0, distanceMeters: 0 }],
  };
  const count = Math.max(1, Math.ceil(metrics.distanceMeters / Math.max(5, stepMeters)));
  const points: PlateauLineOfSightPathPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const distanceMeters = metrics.distanceMeters * index / count;
    const point = index === count
      ? subject
      : calculateKarneyDestinationPoint(
          { ...candidate, height: 0, label: "PLATEAU見通し線" },
          metrics.bearingDegrees,
          distanceMeters
        );
    points.push({
      latitude: point.latitude,
      longitude: point.longitude,
      fraction: distanceMeters / metrics.distanceMeters,
      distanceMeters,
    });
  }
  return { distanceMeters: metrics.distanceMeters, points };
}

function lineHeightMeters(
  candidateHeightMeters: number,
  subjectHeightMeters: number,
  distanceMeters: number,
  fraction: number
): number {
  const linear = candidateHeightMeters + (subjectHeightMeters - candidateHeightMeters) * fraction;
  const fromCandidate = distanceMeters * fraction;
  const toSubject = distanceMeters - fromCandidate;
  const curvatureBulge = fromCandidate * toSubject / (2 * effectiveEarthRadiusMeters());
  return linear - curvatureBulge;
}

function bboxOverlapsSegment(
  bbox: readonly [number, number, number, number],
  start: PlateauLineOfSightCoordinate,
  end: PlateauLineOfSightCoordinate
): boolean {
  return Math.max(start.latitude, end.latitude) >= bbox[0] &&
    Math.min(start.latitude, end.latitude) <= bbox[2] &&
    Math.max(start.longitude, end.longitude) >= bbox[1] &&
    Math.min(start.longitude, end.longitude) <= bbox[3];
}

export function plateauPathIntersectsBbox(
  pathPoints: readonly PlateauLineOfSightCoordinate[],
  bbox: readonly [number, number, number, number]
): boolean {
  for (let index = 1; index < pathPoints.length; index += 1) {
    if (bboxOverlapsSegment(bbox, pathPoints[index - 1], pathPoints[index])) return true;
  }
  return false;
}

export function findPlateauLineOfSightBlocker(
  path: { distanceMeters: number; points: readonly PlateauLineOfSightPathPoint[] },
  candidateHeightMeters: number,
  subjectHeightMeters: number,
  buildings: readonly PlateauLineOfSightBuilding[],
  excludedBuildingKeys: ReadonlySet<string>
): PlateauLineOfSightBlocker | null {
  let nearest: PlateauLineOfSightBlocker | null = null;
  for (const building of buildings) {
    if (excludedBuildingKeys.has(`${building.dataset}\u0000${building.buildingId}`)) continue;
    for (let pathIndex = 1; pathIndex < path.points.length; pathIndex += 1) {
      const start = path.points[pathIndex - 1];
      const end = path.points[pathIndex];
      if (!bboxOverlapsSegment(building.bbox, start, end)) continue;
      for (const face of building.geometry.topFaces) {
        for (const [lower, upper] of insideIntervals(start, end, face)) {
          const localFraction = (lower + upper) / 2;
          const fraction = start.fraction + (end.fraction - start.fraction) * localFraction;
          const distanceFromCandidateMeters = path.distanceMeters * fraction;
          if (distanceFromCandidateMeters <= ENDPOINT_EXCLUSION_METERS ||
            path.distanceMeters - distanceFromCandidateMeters <= ENDPOINT_EXCLUSION_METERS) continue;
          const latitude = start.latitude + (end.latitude - start.latitude) * localFraction;
          const longitude = start.longitude + (end.longitude - start.longitude) * localFraction;
          const roofHeight = planeHeight(latitude, longitude, face[0]) ??
            building.geometry.maximumHeightMeters;
          const sightHeight = lineHeightMeters(
            candidateHeightMeters,
            subjectHeightMeters,
            path.distanceMeters,
            fraction
          );
          if (sightHeight < building.geometry.minimumHeightMeters - HEIGHT_TOLERANCE_METERS ||
            sightHeight > roofHeight + HEIGHT_TOLERANCE_METERS) continue;
          if (!nearest || distanceFromCandidateMeters < nearest.distanceFromCandidateMeters) {
            nearest = {
              dataset: building.dataset,
              buildingId: building.buildingId,
              distanceFromCandidateMeters,
            };
          }
        }
      }
    }
  }
  return nearest;
}

export const plateauLineOfSightInternalsForTests = {
  insideFace,
  insideIntervals,
  lineHeightMeters,
  planeHeight,
};
