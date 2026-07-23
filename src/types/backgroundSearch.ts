import type { CalculationMode, CameraSettings } from "./camera";
import type { GroundPoint } from "./points";
import type { SpotPresetResult, SpotSearchCriteria } from "./search";

export type SerializedSpotPresetResult = Omit<SpotPresetResult, "date"> & {
  date: string;
};

export type SpotSearchJobInput = {
  criteria: SpotSearchCriteria;
  subject: GroundPoint;
  baseDateIso: string;
  timeZone: string;
  lensCenterHeightMeters: number;
  /** v1互換: 未設定の旧ジョブは24mmフルサイズへフォールバック。 */
  cameraSettings?: CameraSettings;
  previewAspectRatio?: number;
  subjectGroundHeightMeters: number;
  calculationMode: CalculationMode;
};

export type SpotSearchJobStatus =
  | "queued"
  | "running"
  | "awaiting-3d"
  | "complete"
  | "failed";

export type SpotSearchJob = {
  version: 1;
  clientId: string;
  jobId: string;
  status: SpotSearchJobStatus;
  progress: string;
  input: SpotSearchJobInput;
  results: SerializedSpotPresetResult[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};
