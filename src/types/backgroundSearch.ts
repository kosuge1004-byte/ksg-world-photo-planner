import type { CalculationMode, CameraSettings } from "./camera";
import type { CameraViewCorrection } from "./camera";
import type { PrecisionSettings } from "./precision";
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
  /** キャッシュ・再開条件の同一性判定に使用する撮影方向補正。 */
  viewCorrection?: CameraViewCorrection;
  /** キャッシュ・再開条件の同一性判定に使用する精度設定スナップショット。 */
  precisionSettings?: PrecisionSettings;
  /** 同一地点・天体の検索準備データが端末側で作成済みか。 */
  cacheState?: "cold" | "warm";
  /** 検索完了後に端末側へ準備済み状態を保存するためのキー。 */
  cacheKey?: string;
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
  progressPercent?: number;
  input: SpotSearchJobInput;
  results: SerializedSpotPresetResult[];
  error?: string;
  createdAt: string;
  updatedAt: string;
};
