import {
  Cartesian3,
  ClassificationType,
  Color,
  Entity,
  NearFarScalar,
  PolylineDashMaterialProperty,
  Viewer,
} from "cesium";

import type { CelestialBodyId, TripodCandidate } from "../types/celestial";
import type { TripodCandidateRiseSetArc } from "./tripodCandidateRiseSetArc";

const ENTITY_ID_PREFIX = "ksg-tripod-candidate";

const CANDIDATE_COLOR_BY_ID: Record<CelestialBodyId, string> = {
  sun: "#ffc928",
  moon: "#52d0ff",
  milkyWay: "#da9aff",
  polaris: "#c0a1ff",
};

function candidateColor(id: CelestialBodyId): Color {
  return Color.fromCssColorString(CANDIDATE_COLOR_BY_ID[id] ?? "#ffc928");
}

function entityId(candidate: TripodCandidate, index: number): string {
  const intersection = candidate.intersectionIndex ?? index + 1;
  return `${ENTITY_ID_PREFIX}:${candidate.id}:${intersection}:${candidate.distanceMeters.toFixed(1)}`;
}

/**
 * 2D地図で表示している確定三脚候補を、3D地図にも同じ候補座標で描画する。
 * 候補計算の値は変更せず、描画だけをCesium Entityへ反映する。
 *
 * candidate.height は calculateTripodCandidates() が返した楕円体高なので、
 * そのまま Cartesian3.fromDegrees() に渡す。Google Photorealistic 3D Tiles上で
 * 地表面との微小な差があっても候補点自体を見失わないよう、点は深度テストを
 * 無効化して常に視認できるようにする。
 */
export function updateTripodCandidateEntities(
  viewer: Viewer,
  candidates: TripodCandidate[],
  candidateRiseSetArcs: readonly TripodCandidateRiseSetArc[] = []
): void {
  if (viewer.isDestroyed()) return;

  clearTripodCandidateEntities(viewer);

  candidates.forEach((candidate, index) => {
    if (
      !Number.isFinite(candidate.latitude) ||
      !Number.isFinite(candidate.longitude) ||
      !Number.isFinite(candidate.height)
    ) {
      return;
    }

    viewer.entities.add(
      new Entity({
        id: entityId(candidate, index),
        name: `${candidate.label} 三脚候補 ${Math.round(candidate.distanceMeters)}m`,
        position: Cartesian3.fromDegrees(
          candidate.longitude,
          candidate.latitude,
          candidate.height
        ),
        point: {
          pixelSize: 15,
          color: candidateColor(candidate.id),
          outlineColor: Color.WHITE,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(100, 1, 100_000, 0.75),
        },
      })
    );
  });

  for (const arc of candidateRiseSetArcs) {
    const positions = arc.points.flatMap((candidate) =>
      Number.isFinite(candidate.longitude) && Number.isFinite(candidate.latitude)
        ? [candidate.longitude, candidate.latitude]
        : []
    );
    if (positions.length < 4) continue;
    viewer.entities.add(new Entity({
      id: `${ENTITY_ID_PREFIX}:${arc.id}-rise-set-arc`,
      name: `${arc.points[0]?.label ?? arc.id}の出から入までの三脚候補線`,
      polyline: {
        // 2026-10-05修正: Google Photorealistic 3D（globe無し）では、線を
        // 「楕円体高+2m」の空間上の線として置き、深度テストに負けた区間も
        // depthFailMaterialで透かして描いていた。線の高さが実際の表面と一致
        // しないため、3Dマップを動かすと視差で線が建物や地面の上を滑って見えた。
        // 探索基礎ライン（水色）と同じく常に表面へ貼り付け、緯度経度だけで
        // 位置を決める。地形(globe)にも3D Tilesにも貼り付くので、視点を
        // どう動かしても同じ場所にとどまる。
        positions: Cartesian3.fromDegreesArray(positions),
        clampToGround: true,
        classificationType: ClassificationType.BOTH,
        // 従来の三脚候補線(1.25px)からさらに半分へ細くする。
        width: 0.625,
        material: new PolylineDashMaterialProperty({
          color: Color.RED.withAlpha(0.98),
          dashLength: 12,
          dashPattern: 255,
        }),
      },
    }));
  }

  viewer.scene.requestRender();
}

export function clearTripodCandidateEntities(viewer: Viewer): void {
  if (viewer.isDestroyed()) return;
  for (const entity of [...viewer.entities.values]) {
    if (
      typeof entity.id === "string" &&
      entity.id.startsWith(`${ENTITY_ID_PREFIX}:`)
    ) {
      viewer.entities.remove(entity);
    }
  }
  viewer.scene.requestRender();
}
