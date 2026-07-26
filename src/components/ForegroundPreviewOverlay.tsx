import { projectForegroundObjectToPreview } from "../preview/foregroundProjection";
import type { CameraSettings } from "../types/camera";
import type { ForegroundObject } from "../types/foreground";
import type { GroundPoint } from "../types/points";

type Props = {
  object: ForegroundObject | null;
  tripod: GroundPoint | null;
  subject: GroundPoint | null;
  camera: CameraSettings;
  aspectRatio: number;
};

export function ForegroundPreviewOverlay({ object, tripod, subject, camera, aspectRatio }: Props) {
  if (!object?.enabled || !tripod || !subject) return null;
  const box = projectForegroundObjectToPreview(
    object,
    tripod,
    subject,
    camera,
    aspectRatio
  );
  if (
    !box ||
    box.centerXPercent < -20 ||
    box.centerXPercent > 120 ||
    box.topPercent > 120 ||
    box.topPercent + box.heightPercent < -20
  ) {
    return null;
  }
  return <div className="foreground-preview-object" style={{left:`${box.centerXPercent}%`,top:`${box.topPercent}%`,height:`${box.heightPercent}%`,width:`${box.widthPercent}%`}} aria-label={`人物 ${object.heightCm}cm`}>
    <svg viewBox="0 0 80 200" preserveAspectRatio="xMidYMax meet"><circle cx="40" cy="18" r="18"/><path d="M26 40 Q40 34 54 40 L62 112 53 112 58 200 43 200 40 126 37 200 22 200 27 112 18 112Z"/></svg>
  </div>;
}
