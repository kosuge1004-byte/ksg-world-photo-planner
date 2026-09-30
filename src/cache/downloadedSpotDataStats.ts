import type { DownloadedSpotDataRecord } from "./downloadedSpotData";
import { withAbortableTimeout } from "../utils/abortableSemaphore";
import { getBearingProfileStorageStats } from "./tripodBearingProfileCache";
import { requiredCelestialTripodBearings } from "./tripodBearingProfileManager";
import { findPrecomputedBearingProfileTarget } from "../data/precomputedBearingProfileTargets";
import { getPersistentSiteContextStatsForSpot, getPersistentSiteContextTotalStorageStats } from "./siteContextPersistentCache";
import { getGsiDeviceTileStorageStatsForDownloadedSpot, getGsiDownloadedSpotsTotalStorageStats } from "../cesium/gsiDemTileCache";

export type DownloadedSpotStorageState = "complete" | "partial" | "needs-update";

export type DownloadedSpotStorageStats = {
  subjectId: string;
  state: DownloadedSpotStorageState;
  profileEntries: number;
  profileBytes: number;
  demReferencedTiles: number;
  demLiveTiles: number;
  demExpiredTiles: number;
  demBytes: number;
  siteContextReferencedCount: number;
  siteContextLiveCount: number;
  siteContextExpiredCount: number;
  siteContextBytes: number;
  totalReferencedBytes: number;
};

export type DownloadedSpotStorageSummary = {
  bySubjectId: Record<string, DownloadedSpotStorageStats>;
  uniqueManagedBytes: number;
  uniqueDemBytes: number;
  uniqueSiteContextBytes: number;
  profileBytes: number;
  originUsageBytes: number | null;
  originQuotaBytes: number | null;
};

export async function inspectDownloadedSpotStorage(records: readonly DownloadedSpotDataRecord[]): Promise<DownloadedSpotStorageSummary> {
  const pairs = await Promise.all(records.map(async (record) => {
    const [profile, dem, site] = await Promise.all([
      getBearingProfileStorageStats(record.subjectId),
      getGsiDeviceTileStorageStatsForDownloadedSpot(record.subjectId),
      getPersistentSiteContextStatsForSpot(record.subjectId),
    ]);
    let state: DownloadedSpotStorageState = "complete";
    // 2026-09-30: 水面・道路・建物情報（site）はダウンロード対象から外したため、
    // 状態判定に使わない（旧データの容量表示・削除管理のためstatsには残す）。
    // 2026-09-30: 登録スポットの計算済みファイル経路は、方位プロファイルそのものが
    // 完全な1m計算結果であり、保存用DEMタイルを意図的に取得しない。DEMタイルの
    // 有無を登録スポットの完了条件にすると、別用途でタイルが保存されていない
    // 端末では永久に「一部不足」になっていた。
    const demRequired = !findPrecomputedBearingProfileTarget(record.latitude, record.longitude);
    if (dem.expiredTiles > 0) state = "needs-update";
    else if (
      record.status !== "complete" ||
      profile.entryCount < requiredCelestialTripodBearings(record.latitude).length ||
      (demRequired && (dem.referencedTiles === 0 || dem.liveTiles === 0))
    ) state = "partial";
    const stats: DownloadedSpotStorageStats = {
      subjectId: record.subjectId,
      state,
      profileEntries: profile.entryCount,
      profileBytes: profile.bytes,
      demReferencedTiles: dem.referencedTiles,
      demLiveTiles: dem.liveTiles,
      demExpiredTiles: dem.expiredTiles,
      demBytes: dem.bytes,
      siteContextReferencedCount: site.referencedCount,
      siteContextLiveCount: site.liveCount,
      siteContextExpiredCount: site.expiredCount,
      siteContextBytes: site.bytes,
      totalReferencedBytes: profile.bytes + dem.bytes + site.bytes,
    };
    return [record.subjectId, stats] as const;
  }));

  const [demTotal, siteTotal] = await Promise.all([
    getGsiDownloadedSpotsTotalStorageStats(),
    getPersistentSiteContextTotalStorageStats(),
  ]);
  const profileBytes = pairs.reduce((sum, [, stats]) => sum + stats.profileBytes, 0);
  let originUsageBytes: number | null = null;
  let originQuotaBytes: number | null = null;
  try {
    const estimate = await withAbortableTimeout(async () => navigator.storage?.estimate?.(),
      3_000, "保存容量の確認がタイムアウトしました");
    originUsageBytes = typeof estimate?.usage === "number" ? estimate.usage : null;
    originQuotaBytes = typeof estimate?.quota === "number" ? estimate.quota : null;
  } catch {
    // Browser/WebView may not expose StorageManager; managed-cache stats still work.
  }
  return {
    bySubjectId: Object.fromEntries(pairs),
    uniqueManagedBytes: profileBytes + demTotal.bytes + siteTotal.bytes,
    uniqueDemBytes: demTotal.bytes,
    uniqueSiteContextBytes: siteTotal.bytes,
    profileBytes,
    originUsageBytes,
    originQuotaBytes,
  };
}
