import type { CameraSettings, PreviewFrameMode } from "./camera";
import type { CelestialVisibility } from "./celestial";
import type { GroundPoint } from "./points";
import type { ForegroundObject } from "./foreground";

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
  mapViewMode: "2d" | "3d";
  mapZoom: number;
  mapCenter: { latitude: number; longitude: number };
  displaySettings: {
    celestialMenuOpen: boolean;
  };
};
