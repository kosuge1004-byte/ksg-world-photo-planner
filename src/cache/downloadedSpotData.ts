export type DownloadedSpotDataRecord = {
  subjectId: string;
  label: string;
  latitude: number;
  longitude: number;
  downloadedAtIso: string;
  status: "complete" | "partial";
  profilePoints: number;
  highPrecisionPoints: number;
  demTileCount?: number;
  demTileBytes?: number;
};

const STORAGE_KEY = "astrosight-downloaded-spot-data-v1";

export function listDownloadedSpotData(): DownloadedSpotDataRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function upsertDownloadedSpotData(record: DownloadedSpotDataRecord): DownloadedSpotDataRecord[] {
  const next = [record, ...listDownloadedSpotData().filter((item) => item.subjectId !== record.subjectId)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeDownloadedSpotData(subjectId: string): DownloadedSpotDataRecord[] {
  const next = listDownloadedSpotData().filter((item) => item.subjectId !== subjectId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
