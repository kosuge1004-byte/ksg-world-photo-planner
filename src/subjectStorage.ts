import type { GroundPoint } from "./types/points";

export type SubjectRecord = GroundPoint & {
  id: string;
  placeId?: string;
  searchType: "place" | "google-maps-url" | "coordinates" | "saved";
  createdAt: string;
  lastUsedAt: string;
};

const HISTORY_KEY = "ksg-subject-search-history-v1";
const HISTORY_LIMIT = 10;

function read(key: string): SubjectRecord[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(key: string, records: SubjectRecord[]): SubjectRecord[] {
  localStorage.setItem(key, JSON.stringify(records));
  return records;
}

function sameLocation(a: Pick<GroundPoint, "latitude" | "longitude">, b: Pick<GroundPoint, "latitude" | "longitude">) {
  return Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;
}

export function idFor(point: GroundPoint) {
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

export function loadSubjectHistory(): SubjectRecord[] {
  return read(HISTORY_KEY).slice(0, HISTORY_LIMIT);
}

export function addSubjectHistory(point: GroundPoint, searchType: SubjectRecord["searchType"]): SubjectRecord[] {
  const now = new Date().toISOString();
  const current = loadSubjectHistory();
  const existing = current.find((item) => sameLocation(item, point));
  const next: SubjectRecord = {
    ...point,
    id: existing?.id ?? idFor(point),
    searchType,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  return write(HISTORY_KEY, [next, ...current.filter((item) => !sameLocation(item, point))].slice(0, HISTORY_LIMIT));
}
