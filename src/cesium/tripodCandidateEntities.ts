import {
  Cartesian3,
  Color,
  Entity,
  NearFarScalar,
  PolylineGlowMaterialProperty,
  Viewer,
} from "cesium";

import type { CelestialBodyId, TripodCandidate } from "../types/celestial";
import type { GroundPoint } from "../types/points";
import { orderTripodCandidatesForArc } from "./tripodCandidateArc";

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
  subject: GroundPoint | null
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

  const arc = orderTripodCandidatesForArc(subject, candidates);
  if (arc.length >= 2) {
    const hasTerrainGlobe = Boolean(viewer.scene.globe);
    viewer.entities.add(new Entity({
      id: `${ENTITY_ID_PREFIX}:arc`,
      name: "三脚候補円弧",
      polyline: {
        positions: hasTerrainGlobe
          ? Cartesian3.fromDegreesArray(
              arc.flatMap((candidate) => [candidate.longitude, candidate.latitude])
            )
          : Cartesian3.fromDegreesArrayHeights(
              arc.flatMap((candidate) => [
                candidate.longitude,
                candidate.latitude,
                candidate.height + 0.5,
              ])
            ),
        // 標準3Dは地形へクランプする。Google Photorealisticモードはglobe=false
        // なので、確定候補自身の楕円体高を使用して線が消えないようにする。
        clampToGround: hasTerrainGlobe,
        width: 5,
        material: new PolylineGlowMaterialProperty({
          color: Color.WHITE.withAlpha(0.96),
          glowPower: 0.22,
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
