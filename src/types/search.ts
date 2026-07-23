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
  interval: SpotSearchInterval;
  displayCount: SpotSearchDisplayCount;
  siteConstraints: SiteConstraintFlags;
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
  alignmentErrorDegrees: number;
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
