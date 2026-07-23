import {
  Cartesian3,
  Color,
  Viewer,
} from "cesium";

import type { GroundPoint } from "../types/points";

const CONNECTION_LINE_ID = "ksg-tripod-subject-line";

export function updateConnectionLine(
  viewer: Viewer,
  tripod: GroundPoint | null,
  subject: GroundPoint | null
): void {
  const previous = viewer.entities.getById(CONNECTION_LINE_ID);

  if (previous) {
    viewer.entities.remove(previous);
  }

  if (!tripod || !subject) {
    return;
  }

  viewer.entities.add({
    id: CONNECTION_LINE_ID,
    name: "三脚から被写体への視線",
    polyline: {
      positions: [
        Cartesian3.fromDegrees(
          tripod.longitude,
          tripod.latitude,
          tripod.height + 2
        ),
        Cartesian3.fromDegrees(
          subject.longitude,
          subject.latitude,
          subject.height
        ),
      ],
      width: 4,
      material: Color.CYAN.withAlpha(0.9),
      clampToGround: false,
    },
  });
}
