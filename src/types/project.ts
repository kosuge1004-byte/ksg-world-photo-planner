import type { CameraSettings, CameraViewCorrection, PreviewFrameMode } from "./camera";
import type { CelestialVisibility } from "./celestial";
import type { GroundPoint } from "./points";
import type { ForegroundObject } from "./foreground";
import type { PrecisionSettings } from "./precision";

export type PlannerProject = {
  id: string;
  name: string;
  createdAtIso: string;
  updatedAtIso: string;
  shootingDateTimeLocal: string;
  timeZone: string;
  calendarRegistered: boolean;
  subject: GroundPoint;
  tripod: GroundPoint;
  foregroundObjects: ForegroundObject[];
  cameraSettings: CameraSettings;
  celestialVisibility: CelestialVisibility;
  previewFrameMode: PreviewFrameMode;
  /** 旧プロジェクトでは未保存。読み込み時は必ず0補正へ正規化する。 */
  viewCorrection?: CameraViewCorrection;
  /** 端末ローカル設定を候補計算へ混入させない。 */
  precisionSettings?: PrecisionSettings;
  mapViewMode: "2d" | "3d";
  mapZoom: number;
  mapCenter: { latitude: number; longitude: number };
  displaySettings: {
    celestialMenuOpen: boolean;
  };
};
