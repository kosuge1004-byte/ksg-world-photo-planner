import { saveToLocalStorage } from "../storage/safeLocalStorage";
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
  /** 建物・塔等を名称変更しても、再配置・更新で地表へ戻さない。 */
  subjectSurfaceTarget?: "terrain" | "structure-roof";
  structureHeightMeters?: number;
  /** Dynamic Spot fields are optional so every v1 record remains readable. */
  dynamicSpotId?: string;
  dynamicSpotCoordinateKey?: string;
  dynamicSpotProfileVersion?: string;
  dynamicSpotHeightSourceType?: "official" | "plateau-measured" | "osm-height" | "osm-levels-estimate" | "unknown";
  dynamicSpotHeightStatus?: "verified" | "measured" | "estimated" | "unknown";
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
  saveToLocalStorage(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeDownloadedSpotData(subjectId: string): DownloadedSpotDataRecord[] {
  const next = listDownloadedSpotData().filter((item) => item.subjectId !== subjectId);
  saveToLocalStorage(STORAGE_KEY, JSON.stringify(next));
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
  saveToLocalStorage(STORAGE_KEY, JSON.stringify(next));
  return next;
}
