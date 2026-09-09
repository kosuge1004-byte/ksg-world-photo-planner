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

/**
 * 2026-09-09追記（お気に入り機能の廃止に伴う統合）: 「お気に入り」の
 * 名称変更機能を、唯一の保存済みリストとなったダウンロード済みデータへ
 * 移管する。
 */
export function renameDownloadedSpotData(subjectId: string, label: string): DownloadedSpotDataRecord[] {
  const trimmed = label.trim();
  const current = listDownloadedSpotData();
  if (!trimmed) return current;
  const next = current.map((item) => (item.subjectId === subjectId ? { ...item, label: trimmed } : item));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
