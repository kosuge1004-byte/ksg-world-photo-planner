export type SearchResult = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
};

export type GoogleMapsResolveResponse = {
  latitude?: number;
  longitude?: number;
  resolvedUrl?: string;
  error?: string;
};

export type SearchCelestialId = "sun" | "moon" | "milkyWay";
export type SunSearchTiming = "all" | "sunrise" | "sunset" | "sunrise-sunset";

export type SpotSearchPeriod =
  | "1-month"
  | "3-months"
  | "6-months"
  | "1-year"
  | "custom";

export type SpotSearchInterval =
  | "1-minute"
  | "5-minutes"
  | "10-minutes"
  | "15-minutes"
  | "30-minutes"
  | "1-hour"
  | "1-day"
  | "1-week"
  | "1-month";

export type SpotSearchDisplayCount = 1 | 3 | 5 | 10 | 20 | 50 | 100;

/**
 * 検索候補を削除せず利用者が現地・プレビューで確認できるよう、
 * 天体方向に対するPhotorealistic 3Dの確認状態を候補へ保持する。
 */
export type SpotCandidate3dStatus =
  | "visible"
  | "possibly-obstructed"
  | "unverified"
  | "disabled";

export type SpotSearchCriteria = {
  query: string;
  useCurrentSubjectPin: boolean;
  celestialId: SearchCelestialId;
  sunSearchTiming: SunSearchTiming;
  /** 月齢（日）。月以外の検索では使用しない。 */
  moonAgeMinDays: number;
  moonAgeMaxDays: number;
  focalLengthMm: number;
  /** 被写体から三脚候補までの距離範囲（m）。 */
  tripodDistanceMinMeters: number;
  tripodDistanceMaxMeters: number;
  period: SpotSearchPeriod;
  customStartDate: string;
  customEndDate: string;
  /** 0=日曜〜6=土曜。空配列は全曜日。 */
  weekdays: number[];
  /** ローカル時刻の検索範囲。開始>終了は日付またぎ。 */
  startTime?: string;
  endTime?: string;
  interval: SpotSearchInterval;
  displayCount: SpotSearchDisplayCount;
  siteConstraints: SiteConstraintFlags;
  /** 三脚候補から被写体ピンまでのPhotorealistic 3D遮蔽物確認。 */
  subjectObstructionCheckEnabled: boolean;
  /** Google 3D Tilesで被写体まで遮蔽なしと確認できた候補だけを結果へ残す。 */
  verifiedVisibilityOnly: boolean;
  /** 被写体までの距離帯ごとに、被写体ピン直前で判定から除外する距離（m）。 */
  subjectObstructionExclusionMeters: import("./precision").SubjectObstructionExclusionSettings;
  /** ②建物3D遮蔽の詳細判定（視直径を考慮した縁サンプリング）設定。 */
  buildingOcclusionDetailSettings: import("./precision").BuildingOcclusionDetailSettings;
};

export type SpotPresetResult = {
  id: string;
  placeLabel: string;
  date: Date;
  timeZone: string;
  subject: GroundPoint;
  tripod: GroundPoint;
  focalLengthMm: number;
  celestialId: SearchCelestialId;
  celestialLabel: string;
  cameraAzimuthDegrees: number;
  cameraAltitudeDegrees: number;
  candidate3dStatus: SpotCandidate3dStatus;
  /** ②建物3D遮蔽の詳細判定を使った場合の、遮蔽サンプル割合（%）。未使用時は未設定。 */
  buildingObstructedFractionPercent?: number;
  nearbyLandmarks: NearbyLandmark[];
  nearbyBuildings: NearbyBuilding[];
  nearbyStructures: NearbyStructure[];
};
import type { GroundPoint } from "./points";
import type {
  NearbyBuilding,
  NearbyLandmark,
  NearbyStructure,
  SiteConstraintFlags,
} from "./geospatial";
