import type { GroundPoint } from "./points";
import type { SearchCelestialId } from "./search";

export type GuidancePlanSource = "search" | "saved" | "current";

export type GuidancePlan = {
  id: string;
  title: string;
  source: GuidancePlanSource;
  tripod: GroundPoint;
  calculatedTripod: GroundPoint;
  subject: GroundPoint;
  dateTimeIso: string;
  timeZone: string;
  focalLengthMm: number;
  lensCenterHeightMeters: number;
  cameraAzimuthDegrees: number;
  cameraAltitudeDegrees: number;
  subjectAzimuthDegrees: number;
  subjectAltitudeDegrees: number;
  celestialId: SearchCelestialId | "polaris";
  celestialLabel: string;
  celestialAzimuthDegrees: number;
  celestialAltitudeDegrees: number;
  viewCorrectionAzimuthDegrees: number;
  viewCorrectionAltitudeDegrees: number;
  createdAtIso: string;
};

export type FieldCorrection = {
  id: string;
  planId: string;
  spotKey: string;
  calculatedTripod: GroundPoint;
  actualTripod: GroundPoint;
  eastOffsetMeters: number;
  northOffsetMeters: number;
  elevationCorrectionMeters: number;
  azimuthCorrectionDegrees: number;
  altitudeCorrectionDegrees: number;
  lensCenterHeightMeters: number;
  targetLabel: string;
  compositionTitle: string;
  gpsAccuracyMeters: number;
  savedAtIso: string;
};

export type GuidancePhase =
  | "GPS接近中"
  | "目標付近"
  | "AR調整中"
  | "構図一致";

export type LivePosition = GroundPoint & {
  accuracyMeters: number;
  altitudeAccuracyMeters: number | null;
  source: "gps";
  timestampMilliseconds: number;
};

export type DeviceAttitude = {
  headingDegrees: number | null;
  cameraAltitudeDegrees: number | null;
  rollDegrees: number | null;
  absolute: boolean;
};
