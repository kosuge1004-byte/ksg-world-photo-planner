import type { CameraSettings } from "./camera";
import type { GroundPoint } from "./points";
import type { SiteContext } from "./geospatial";

/**
 * 2026-09-08追記: 三脚候補周辺データ（360方位ぶんの地形プロファイル）の
 * 取得を、spotSearchJob（server/spotSearchJobs.ts）と同じ設計で
 * サーバー側バックグラウンドジョブ化する。
 *
 * 狙い: 端末（ブラウザ/WebView）のJS実行は、タブ/アプリを閉じると
 * 完全に停止する（ブラウザの仕様であり回避不能）。既存のクライアント
 * 駆動ループ（tripodBearingProfileManager.backfillBearingProfiles）では
 * アプリを閉じている間ダウンロードが進まない。GSI/Overpassへの大量の
 * 往復通信で「分」単位かかる処理をCloudflare Worker側（Queue Consumer）
 * で実行すれば、端末がオフライン・アプリ終了中でも計算は進む。
 */

/** 1方位分の実測地形プロファイル1点（tripodBearingProfileCache.BearingProfilePointと同一形状）。 */
export type SerializedBearingProfilePoint = {
  distanceMeters: number;
  longitude: number;
  latitude: number;
  ellipsoidalHeightMeters: number;
};

/** 1方位分の実測地形プロファイル（tripodBearingProfileCache.BearingProfileEntryと同一形状）。 */
export type SerializedBearingProfileEntry = {
  bearingDegrees: number;
  points: SerializedBearingProfilePoint[];
  computedAtIso: string;
};

/** 被写体周辺のOSM/水面判定対象1点（siteContext.SiteContextPointと同一形状）。 */
export type SerializedSiteContextPoint = {
  latitude: number;
  longitude: number;
};

export type BearingProfileDownloadJobInput = {
  subjectId: string;
  subjectPoint: GroundPoint;
  cameraSettings: CameraSettings;
  /** 端末側で既にキャッシュ済みと分かっている方位は含めない（無駄な再計算をしない）。 */
  pendingBearings: number[];
};

export type BearingProfileDownloadJobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed";

export type BearingProfileDownloadJob = {
  version: 1;
  clientId: string;
  jobId: string;
  status: BearingProfileDownloadJobStatus;
  progress: string;
  progressPercent: number;
  input: BearingProfileDownloadJobInput;
  /** 完了時のみ埋まる。既存のBearingProfileEntry群としてそのままIndexedDBへ書き込める形状。 */
  profiles: SerializedBearingProfileEntry[];
  /** 完了時のみ埋まる。既存のwritePersistentSiteContexts(points, contexts, ...)へそのまま渡せる形状。 */
  waterSiteContextPoints: SerializedSiteContextPoint[];
  waterSiteContexts: SiteContext[];
  fullSiteContextPoints: SerializedSiteContextPoint[];
  fullSiteContexts: SiteContext[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};
