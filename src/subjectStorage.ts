import type { GroundPoint } from "./types/points";

export type SubjectRecord = GroundPoint & {
  id: string;
  placeId?: string;
  searchType: "place" | "google-maps-url" | "coordinates" | "saved";
  createdAt: string;
  lastUsedAt: string;
};

const HISTORY_KEY = "ksg-subject-search-history-v1";
const FAVORITES_KEY = "ksg-subject-favorites-v1";
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

export function loadFavoriteSubjects(): SubjectRecord[] {
  return read(FAVORITES_KEY);
}

export function toggleFavoriteSubject(point: GroundPoint): SubjectRecord[] {
  const current = loadFavoriteSubjects();
  const exists = current.some((item) => sameLocation(item, point));
  if (exists) return write(FAVORITES_KEY, current.filter((item) => !sameLocation(item, point)));
  const now = new Date().toISOString();
  const next: SubjectRecord = {
    ...point,
    id: idFor(point),
    searchType: "saved",
    createdAt: now,
    lastUsedAt: now,
  };
  return write(FAVORITES_KEY, [next, ...current]);
}

export function renameFavoriteSubject(id: string, label: string): SubjectRecord[] {
  const current = loadFavoriteSubjects();
  const trimmed = label.trim();
  if (!trimmed) return current;
  return write(
    FAVORITES_KEY,
    current.map((item) => (item.id === id ? { ...item, label: trimmed } : item))
  );
}

export function isFavoriteSubject(records: SubjectRecord[], point: GroundPoint | null): boolean {
  return Boolean(point && records.some((item) => sameLocation(item, point)));
}
